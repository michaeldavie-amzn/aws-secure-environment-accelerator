import * as fs from 'fs';
import * as path from 'path';
import * as cdk from '@aws-cdk/core';
import * as codebuild from '@aws-cdk/aws-codebuild';
import * as codepipeline from '@aws-cdk/aws-codepipeline';
import * as actions from '@aws-cdk/aws-codepipeline-actions';
import * as iam from '@aws-cdk/aws-iam';
import * as lambda from '@aws-cdk/aws-lambda';
import * as s3 from '@aws-cdk/aws-s3';

process.on('unhandledRejection', (reason, _) => {
  console.error(reason);
  // eslint-disable-next-line no-process-exit
  process.exit(1);
});

async function main() {
  const pkg = require('../package.json');
  const acceleratorVersion = pkg.version;

  const app = new cdk.App();

  const stack = new cdk.Stack(app, 'InstallerStack', {
    stackName: 'AcceleratorInstaller',
    terminationProtection: true,
  });

  const acceleratorPrefixParam = new cdk.CfnParameter(stack, 'AcceleratorPrefix', {
    default: 'PBMMAccel-',
    description: 'Accelerator prefix used for deployment.',
    allowedPattern: '[a-zA-Z][a-zA-Z0-9-]{0,8}-',
  });

  const acceleratorNameParam = new cdk.CfnParameter(stack, 'AcceleratorName', {
    default: 'PBMM',
    description: 'Accelerator Name used for deployment.',
    allowedPattern: '[a-zA-Z][a-zA-Z0-9]{0,3}',
  });

  const acceleratorName = acceleratorNameParam.valueAsString;
  const acceleratorPrefix = acceleratorPrefixParam.valueAsString;

  const acceleratorConfigS3Bucket = new cdk.CfnParameter(stack, 'ConfigS3Bucket', {
    default: 'pbmmaccel-config',
    description: 'The S3 bucket name that contains the initial Accelerator configuration.',
  });

  const configRepositoryName = new cdk.CfnParameter(stack, 'ConfigRepositoryName', {
    default: 'PBMMAccel-Config-Repo',
    description: 'The Code Commit repository name that contains the Accelerator configuration.',
  });

  const configBranchName = new cdk.CfnParameter(stack, 'ConfigBranchName', {
    default: 'main',
    description: 'The Code Commit branch name that contains the Accelerator configuration',
  });

  const githubOauthSecretId = new cdk.CfnParameter(stack, 'GithubSecretId', {
    default: 'accelerator/github-token',
    description: 'The token to use to access the Github repository.',
  });

  const githubOwner = new cdk.CfnParameter(stack, 'GithubOwner', {
    default: 'aws-samples',
    description: 'The owner of the Github repository containing the Accelerator code.',
  });

  const githubRepository = new cdk.CfnParameter(stack, 'GithubRepository', {
    default: 'aws-secure-environment-accelerator',
    description: 'The name of the Github repository containing the Accelerator code.',
  });

  const githubBranch = new cdk.CfnParameter(stack, 'GithubBranch', {
    // Github release action sets GITHUB_DEFAULT_BRANCH
    // Otherwise fall back to 'release'
    default: process.env.GITHUB_DEFAULT_BRANCH || 'release',
    description: 'The branch of the Github repository containing the Accelerator code.',
  });

  const notificationEmail = new cdk.CfnParameter(stack, 'Notification Email', {
    description: 'The notification email that will get Accelerator State Machine execution notifications.',
  });
  const codebuildComputeType = new cdk.CfnParameter(stack, 'CodeBuild Compute Type', {
    description: 'The compute type of the build server for the Accelerator deployments.',
    default: codebuild.ComputeType.MEDIUM,
    allowedValues: [
      codebuild.ComputeType.SMALL,
      codebuild.ComputeType.MEDIUM,
      codebuild.ComputeType.LARGE,
      codebuild.ComputeType.X2_LARGE,
    ],
  });

  const stackDeployPageSize = new cdk.CfnParameter(stack, 'Deployment Page Size', {
    description: 'The number of stacks to deploy in parallel. This value SHOULD NOT normally be changed.',
    default: 900,
  });
  const stateMachineName = `${acceleratorPrefix}MainStateMachine_sm`;

  // The state machine name has to match the name of the state machine in initial setup
  const stateMachineArn = `arn:aws:states:${stack.region}:${stack.account}:stateMachine:${stateMachineName}`;

  // Use the `start-execution.js` script in the assets folder
  const stateMachineStartExecutionCode = fs.readFileSync(path.join(__dirname, '..', 'assets', 'start-execution.js'));

  // Use the `save-application-version.js` script in the assets folder
  const saveApplicationVersionCode = fs.readFileSync(
    path.join(__dirname, '..', 'assets', 'save-application-version.js'),
  );

  // Use the `vallidate-parameters.js` script in the assets folder
  const vallidateParametersCode = fs.readFileSync(path.join(__dirname, '..', 'assets', 'validate-parameters.js'));

  // Role that is used by the CodeBuild project
  const installerProjectRole = new iam.Role(stack, 'InstallerProjectRole', {
    roleName: `${acceleratorPrefix}CB-Installer`,
    assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
  });

  // Allow creation of ECR repositories
  installerProjectRole.addToPrincipalPolicy(
    new iam.PolicyStatement({
      actions: ['ecr:*'],
      resources: [`arn:aws:ecr:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:repository/aws-cdk/*`],
    }),
  );

  // Allow getting authorization tokens for ECR
  installerProjectRole.addToPrincipalPolicy(
    new iam.PolicyStatement({
      actions: ['ecr:GetAuthorizationToken'],
      resources: [`*`],
    }),
  );

  installerProjectRole.addToPrincipalPolicy(
    new iam.PolicyStatement({
      actions: ['sts:AssumeRole'],
      resources: [`arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/cdk-*`],
    }),
  );

  // Allow all CloudFormation permissions
  installerProjectRole.addToPrincipalPolicy(
    new iam.PolicyStatement({
      actions: ['cloudformation:*'],
      resources: [`arn:aws:cloudformation:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:stack/*`],
    }),
  );

  // Allow the role to access the CDK asset bucket
  installerProjectRole.addToPrincipalPolicy(
    new iam.PolicyStatement({
      actions: ['s3:*'],
      resources: [`arn:aws:s3:::cdk-*`],
    }),
  );

  // Allow the role to create anything through CloudFormation
  installerProjectRole.addToPrincipalPolicy(
    new iam.PolicyStatement({
      actions: ['*'],
      resources: ['*'],
      conditions: {
        'ForAnyValue:StringEquals': {
          'aws:CalledVia': ['cloudformation.amazonaws.com'],
        },
      },
    }),
  );

  // This artifact is used as output for the Github code and as input for the build step
  const sourceArtifact = new codepipeline.Artifact();

  const githubAction = new actions.GitHubSourceAction({
    actionName: 'GithubSource',
    owner: githubOwner.valueAsString,
    repo: githubRepository.valueAsString,
    branch: githubBranch.valueAsString,
    oauthToken: cdk.SecretValue.secretsManager(githubOauthSecretId.valueAsString),
    output: sourceArtifact,
    trigger: actions.GitHubTrigger.NONE,
  });

  // Define a build specification to build the initial setup templates
  const installerProject = new codebuild.PipelineProject(stack, 'InstallerProject', {
    projectName: `${acceleratorPrefix}InstallerProject_pl`,
    role: installerProjectRole,
    buildSpec: codebuild.BuildSpec.fromObject({
      version: '0.2',
      phases: {
        install: {
          'runtime-versions': {
            nodejs: 12,
          },
          // The flag '--unsafe-perm' is necessary to run pnpm scripts in Docker
          commands: ['npm install --global pnpm@5.18.9', 'pnpm install --unsafe-perm --frozen-lockfile'],
        },
        build: {
          commands: [
            'cd src/core/cdk',
            'export CDK_NEW_BOOTSTRAP=1',
            `pnpx cdk bootstrap aws://${cdk.Aws.ACCOUNT_ID}/${cdk.Aws.REGION} --require-approval never --toolkit-stack-name=${acceleratorPrefix}CDKToolkit --cloudformation-execution-policies=arn:aws:iam::aws:policy/AdministratorAccess`,
            `pnpx cdk deploy --require-approval never --toolkit-stack-name=${acceleratorPrefix}CDKToolkit`,
          ],
        },
      },
    }),
    environment: {
      buildImage: codebuild.LinuxBuildImage.STANDARD_5_0,
      privileged: true, // Allow access to the Docker daemon
      computeType: codebuildComputeType.valueAsString as codebuild.ComputeType,
      environmentVariables: {
        ACCELERATOR_NAME: {
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          value: acceleratorName,
        },
        ACCELERATOR_PREFIX: {
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          value: acceleratorPrefix,
        },
        ACCELERATOR_STATE_MACHINE_NAME: {
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          value: stateMachineName,
        },
        CONFIG_REPOSITORY_NAME: {
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          value: configRepositoryName.valueAsString,
        },
        CONFIG_BRANCH_NAME: {
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          value: configBranchName.valueAsString,
        },
        CONFIG_S3_BUCKET: {
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          value: acceleratorConfigS3Bucket.valueAsString,
        },
        ENABLE_PREBUILT_PROJECT: {
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          value: 'true', // Enable Docker prebuilt project
        },
        BUILD_COMPUTE_TYPE: {
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          value: codebuildComputeType.valueAsString,
        },
        DEPLOY_STACK_PAGE_SIZE: {
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          value: stackDeployPageSize.valueAsString,
        },
        NOTIFICATION_EMAIL: {
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          value: notificationEmail.valueAsString,
        },
        SOURCE_REPO: {
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          value: githubRepository.valueAsString,
        },
        SOURCE_BRANCH: {
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          value: githubBranch.valueAsString,
        },
        SOURCE_OWNER: {
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          value: githubOwner.valueAsString,
        },
      },
    },
  });

  // The role that will be used to start the state machine
  const stateMachineExecutionRole = new iam.Role(stack, 'ExecutionRoleName', {
    roleName: `${acceleratorPrefix}L-SFN-Execution`,
    assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
  });

  // Grant permissions to write logs
  stateMachineExecutionRole.addToPrincipalPolicy(
    new iam.PolicyStatement({
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: ['*'],
    }),
  );

  stateMachineExecutionRole.addToPrincipalPolicy(
    new iam.PolicyStatement({
      actions: ['ssm:PutParameter', 'ssm:GetParameter', 'ssm:GetParameterHistory'],
      resources: ['*'],
    }),
  );

  stateMachineExecutionRole.addToPrincipalPolicy(
    new iam.PolicyStatement({
      actions: ['cloudformation:DescribeStacks'],
      resources: ['*'],
    }),
  );

  // Grant permissions to start the state machine
  stateMachineExecutionRole.addToPrincipalPolicy(
    new iam.PolicyStatement({
      actions: ['states:StartExecution'],
      resources: [stateMachineArn],
    }),
  );

  // Create the Lambda function that is responsible for launching the state machine
  const stateMachineStartExecutionLambda = new lambda.Function(stack, 'ExecutionLambda', {
    functionName: `${acceleratorPrefix}Installer-StartExecution`,
    role: stateMachineExecutionRole,
    runtime: lambda.Runtime.NODEJS_12_X,
    code: lambda.Code.fromInline(stateMachineStartExecutionCode.toString()),
    handler: 'index.handler',
  });

  // Create the Lambda function that is responsible for launching the state machine
  const saveApplicationVersionLambda = new lambda.Function(stack, 'SaveApplicationVersionLambda', {
    functionName: `${acceleratorPrefix}Installer-SaveApplicationVersion`,
    role: stateMachineExecutionRole,
    runtime: lambda.Runtime.NODEJS_12_X,
    code: lambda.Code.fromInline(saveApplicationVersionCode.toString()),
    handler: 'index.handler',
  });

  // Create the Lambda function that is responsible for validating previous parameters
  const vallidateParametersLambda = new lambda.Function(stack, 'VallidateParametersLambda', {
    functionName: `${acceleratorPrefix}Installer-VallidateParameters`,
    role: stateMachineExecutionRole,
    runtime: lambda.Runtime.NODEJS_12_X,
    code: lambda.Code.fromInline(vallidateParametersCode.toString()),
    handler: 'index.handler',
  });

  // Role that is used by the CodePipeline
  // Permissions for
  //   - accessing the artifacts bucket
  //   - publishing to the manual approval SNS topic
  //   - running the CodeBuild project
  //   - running the state machine execution Lambda function
  // will be added automatically by the CDK Pipeline construct
  const installerPipelineRole = new iam.Role(stack, 'InstallerPipelineRole', {
    roleName: `${acceleratorPrefix}CP-Installer`,
    assumedBy: new iam.ServicePrincipal('codepipeline.amazonaws.com'),
  });

  // This bucket will be used to store the CodePipeline source
  // Encryption is not necessary for this pipeline so we create a custom unencrypted bucket
  const installerArtifactsBucket = new s3.Bucket(stack, 'ArtifactsBucket', {
    removalPolicy: cdk.RemovalPolicy.DESTROY,
    objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
  });

  // Allow only https requests
  installerArtifactsBucket.addToResourcePolicy(
    new iam.PolicyStatement({
      actions: ['s3:*'],
      resources: [installerArtifactsBucket.bucketArn, installerArtifactsBucket.arnForObjects('*')],
      principals: [new iam.AnyPrincipal()],
      conditions: {
        Bool: {
          'aws:SecureTransport': 'false',
        },
      },
      effect: iam.Effect.DENY,
    }),
  );

  new codepipeline.Pipeline(stack, 'Pipeline', {
    role: installerPipelineRole,
    pipelineName: `${acceleratorPrefix}InstallerPipeline`,
    artifactBucket: installerArtifactsBucket,
    stages: [
      {
        stageName: 'Source',
        actions: [githubAction],
      },
      {
        stageName: 'ValidateParameters',
        actions: [
          new actions.LambdaInvokeAction({
            actionName: 'ValidateParameters',
            lambda: vallidateParametersLambda,
            role: installerPipelineRole,
            userParameters: {
              acceleratorName,
              acceleratorPrefix,
            },
          }),
        ],
      },
      {
        stageName: 'Deploy',
        actions: [
          new actions.CodeBuildAction({
            actionName: 'DeployAccelerator',
            project: installerProject,
            input: sourceArtifact,
            role: installerPipelineRole,
          }),
        ],
      },
      {
        stageName: 'UpdateVersion',
        actions: [
          new actions.LambdaInvokeAction({
            actionName: 'UpdateVersion',
            lambda: saveApplicationVersionLambda,
            role: installerPipelineRole,
            userParameters: {
              commitId: githubAction.variables.commitId,
              repository: githubRepository,
              owner: githubOwner,
              branch: githubBranch,
              acceleratorVersion,
              acceleratorName,
              acceleratorPrefix,
            },
          }),
        ],
      },
      {
        stageName: 'Execute',
        actions: [
          new actions.LambdaInvokeAction({
            actionName: 'ExecuteAcceleratorStateMachine',
            lambda: stateMachineStartExecutionLambda,
            role: installerPipelineRole,
            userParameters: {
              stateMachineArn,
            },
          }),
        ],
      },
    ],
  });

  cdk.Aspects.of(stack).add(new cdk.Tag('Accelerator', acceleratorName));
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
main();

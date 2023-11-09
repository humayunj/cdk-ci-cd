import { CfnOutput, SecretValue } from "aws-cdk-lib";
import {
  BuildSpec,
  ComputeType,
  LinuxBuildImage,
  PipelineProject,
} from "aws-cdk-lib/aws-codebuild";
import { Artifact, Pipeline } from "aws-cdk-lib/aws-codepipeline";
import {
  CodeBuildAction,
  EcsDeployAction,
  GitHubSourceAction,
} from "aws-cdk-lib/aws-codepipeline-actions";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecs_patterns from "aws-cdk-lib/aws-ecs-patterns";
import * as iam from "aws-cdk-lib/aws-iam";
import "dotenv/config";

import { Construct } from "constructs";

export class FargatePipeline extends Construct {
  constructor(scope: Construct, id: string) {
    super(scope, id);
    const vpc = new ec2.Vpc(this, "fargate-docker-greeting", {
      maxAzs: 2,
    });

    const sg = new ec2.SecurityGroup(this, "dg-security-group", {
      vpc,
      allowAllOutbound: true,
    });

    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80));

    const cluster = new ecs.Cluster(this, "docker-greeting-cluster", {
      vpc,
    });

    const taskrole = new iam.Role(this, `ecs-taskrole`, {
      roleName: `ecs-taskrole`,
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });

    const taskDef = new ecs.FargateTaskDefinition(this, "ecs-taskdef", {
      taskRole: taskrole,
    });

    const executionRolePolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      resources: ["*"],
      actions: [
        "ecr:getauthorizationtoken",
        "ecr:batchchecklayeravailability",
        "ecr:getdownloadurlforlayer",
        "ecr:batchgetimage",
      ],
    });

    taskDef.addToExecutionRolePolicy(executionRolePolicy);

    const container = taskDef.addContainer("docker-greeting-app", {
      image: ecs.ContainerImage.fromRegistry("amazon/amazon-ecs-sample"),
      memoryLimitMiB: 256,
      cpu: 256,
    });

    container.addPortMappings({
      containerPort: 80,
      protocol: ecs.Protocol.TCP,
    });

    const service = new ecs_patterns.ApplicationLoadBalancedFargateService(
      this,
      "docker-greeting-service",
      {
        cluster,

        cpu: 512,
        desiredCount: 1,
        taskDefinition: taskDef,
        publicLoadBalancer: true,
      }
    );

    const sourceOutput = new Artifact("SourceArtifact");

    const oAuthSecret = SecretValue.unsafePlainText(
      process.env["GITHUB_TOKEN"]!
    );
    const sourceAction = new GitHubSourceAction({
      actionName: "source",
      repo: process.env["GITHUB_REPO"]!,
      oauthToken: oAuthSecret,
      output: sourceOutput,
      branch: "main",
      owner: process.env["GITHUB_USERNAME"]!,
    });

    const repo = new ecr.Repository(this, "docker-greeting-repo");

    const buildRole = new iam.Role(this, "buildRole", {
      assumedBy: new iam.ServicePrincipal("codebuild.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromManagedPolicyArn(
          this,
          "ECRAccess",
          "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryFullAccess"
        ),
      ],
    });

    const buildOutput = new Artifact("DockerBuildArtifact");

    const buildSpecs = BuildSpec.fromObject({
      version: "0.2",
      phases: {
        pre_build: {
          commands: ["env", "export tag=latest"],
        },
        build: {
          commands: [
            `docker build -t $ecr_repo_uri:$tag .`,
            "$(aws ecr get-login --no-include-email)",
            "docker push $ecr_repo_uri:$tag",
          ],
        },
        post_build: {
          commands: [
            'echo "in post-build stage"',
            `printf \'[{"name":"${container.containerName}","imageUri":"%s"}]\' $ecr_repo_uri:$tag > imagedefinitions.json`,
            "pwd; ls -al; cat imagedefinitions.json",
          ],
        },
      },
      artifacts: {
        files: ["imagedefinitions.json"],
      },
    });
    const buildProject = new PipelineProject(this, "CodeBuildProject", {
      projectName: "app-build",
      vpc,

      environment: {
        buildImage: LinuxBuildImage.AMAZON_LINUX_2_3,
        computeType: ComputeType.SMALL,
        privileged: true,
      },
      environmentVariables: {
        cluster_name: {
          value: `${cluster.clusterName}`,
        },
        ecr_repo_uri: {
          value: `${repo.repositoryUri}`,
        },
      },
      role: buildRole,

      buildSpec: buildSpecs,
    });

    const buildAction = new CodeBuildAction({
      actionName: "codeBuildAction",
      project: buildProject,
      input: sourceOutput,
      runOrder: 1,
      outputs: [buildOutput],
    });

    repo.grantPullPush(buildProject);

    buildProject.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "ecs:describecluster",
          "ecr:getauthorizationtoken",
          "ecr:batchchecklayeravailability",
          "ecr:batchgetimage",
          "ecr:getdownloadurlforlayer",
        ],
        resources: [`${cluster.clusterArn}`],
      })
    );

    const deployAction = new EcsDeployAction({
      actionName: "deployToECSAction",
      service: service.service,
      input: buildOutput,
    });

    const pipeline = new Pipeline(this, "docker-greeting-pipeline", {
      pipelineName: "docker-greeting-pipeline",
      crossAccountKeys: false,
      stages: [
        {
          stageName: "source",
          actions: [sourceAction],
        },
        {
          stageName: "build",
          actions: [buildAction],
        },
        {
          stageName: "deploy",
          actions: [deployAction],
        },
      ],
    });

    // new CfnOutput(this, "image", { value: repo.repositoryUri + ":latest" });
    new CfnOutput(this, "LoadBalancerDns", {
      value: service.loadBalancer.loadBalancerDnsName,
    });
  }
}

import { Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import { FargatePipeline } from "./fargate-pipeline";

export class CdkCiCdStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    new FargatePipeline(this, "dg-stack");
  }
}

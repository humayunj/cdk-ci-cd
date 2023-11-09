#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { CdkCiCdStack } from "../lib/cdk-ci-cd-stack";

const app = new cdk.App();
new CdkCiCdStack(app, "CdkCiCdStack");

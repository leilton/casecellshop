import { SQSClient } from '@aws-sdk/client-sqs';
import type { Config } from './config';

export function createSqs(cfg: Pick<Config, 'AWS_REGION' | 'SQS_ENDPOINT'>): SQSClient {
  return new SQSClient({ region: cfg.AWS_REGION, ...(cfg.SQS_ENDPOINT ? { endpoint: cfg.SQS_ENDPOINT } : {}) });
}

import {
  SESv2Client,
  SendEmailCommand,
} from "@aws-sdk/client-sesv2";

import { MailFailure } from '../mail-failure.js';
export { MailFailure } from '../mail-failure.js';

export class AwsMailProvider {
  name = "aws-ses";
  constructor(
    config,
    client = new SESv2Client({
      region: config.awsRegion,
      maxAttempts: 1,
    }),
  ) {
    this.config = config;
    this.client = client;
    this.ready = Boolean(
      config.awsRegion && config.sesFrom,
    );
  }
  async send({
    email,
    displayName,
    occurredAt,
    timezone,
    type,
    deliveryId,
  }) {
    const date = new Intl.DateTimeFormat("ja-JP", {
      timeZone: timezone,
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(occurredAt));
    const registration = type === "registration";
    const subject = registration
      ? "【安心安否確認】連絡先登録のお知らせ"
      : `【安心安否確認】${displayName}さんからのお知らせ`;
    const text = registration
      ? `${displayName}さんの連絡先として、${date}に登録されました。\n安心安否確認は、ご本人の操作により安否確認メールを送るサービスです。\n誤登録の場合：${this.config.contactAddress}\n本サービスは緊急通報ではありません。`
      : `${displayName}さんが ${date} に安否確認操作を行いました。\n本人の操作により送信された自動メールです。\n本サービスは緊急通報ではありません。\nお問い合わせ：${this.config.contactAddress}`;
    try {
      const result = await this.client.send(
        new SendEmailCommand({
          FromEmailAddress: this.config.sesFrom,
          Destination: { ToAddresses: [email] },
          Content: {
            Simple: {
              Subject: { Charset: "UTF-8", Data: subject },
              Body: {
                Text: { Charset: "UTF-8", Data: text },
              },
            },
          },
          EmailTags: [
            {
              Name: "anshin_delivery_id",
              Value: deliveryId,
            },
          ],
          ...(this.config.sesConfigurationSet
            ? {
                ConfigurationSetName:
                  this.config.sesConfigurationSet,
              }
            : {}),
        }),
        { abortSignal: AbortSignal.timeout(10000) },
      );
      if (!result.MessageId)
        throw new MailFailure("MAIL_RESULT_UNKNOWN", {
          uncertain: true,
        });
      return { messageId: result.MessageId };
    } catch (error) {
      if (error instanceof MailFailure) throw error;
      const http = error.$metadata?.httpStatusCode;
      if (
        http === 429 ||
        error.name === "TooManyRequestsException"
      )
        throw new MailFailure("MAIL-002", {
          retryable: true,
        });
      if (http >= 400 && http < 500)
        throw new MailFailure("MAIL-001");
      // SES has no client idempotency token. An ambiguous timeout must not be retried.
      throw new MailFailure("MAIL_RESULT_UNKNOWN", {
        uncertain: true,
      });
    }
  }
}

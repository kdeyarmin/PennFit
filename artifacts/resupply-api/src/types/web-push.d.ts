declare module "web-push" {
  export interface PushSubscription {
    endpoint: string;
    keys: { auth: string; p256dh: string };
  }

  export interface SendResult {
    statusCode?: number;
  }

  export function setVapidDetails(
    subject: string,
    publicKey: string,
    privateKey: string,
  ): void;

  export function sendNotification(
    subscription: PushSubscription,
    payload: string,
  ): Promise<SendResult>;

  const webPush: {
    setVapidDetails: typeof setVapidDetails;
    sendNotification: typeof sendNotification;
  };

  export default webPush;
}

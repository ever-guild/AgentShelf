export type ConnectionStatus = "not_connected" | "pending" | "ready" | "revoked" | "error";
export type ConnectionNextAction =
  | "continue_paypal"
  | "retry_status"
  | "retry_connection"
  | "contact_support";

export type ConnectionResponse = {
  connection: {
    shopId: string;
    status: ConnectionStatus;
    nextAction?: ConnectionNextAction;
  };
  configured: boolean;
  webhookConfigured?: boolean;
};

export function statusLabel(status: ConnectionStatus): string {
  switch (status) {
    case "ready":
      return "Connected";
    case "pending":
      return "Waiting for PayPal approval";
    case "revoked":
      return "Connection revoked";
    case "error":
      return "Connection needs attention";
    default:
      return "Not connected";
  }
}

export function statusGuidance(input: {
  status: ConnectionStatus;
  nextAction?: ConnectionNextAction;
  hasActionUrl: boolean;
}): string | null {
  switch (input.status) {
    case "ready":
      return "This shop is connected to PayPal Sandbox. Payments remain in sandbox and require the buyer\u2019s approval.";
    case "pending":
      if (input.nextAction === "contact_support") {
        return "PayPal did not confirm whether the connection request was created. Refresh the status in a moment or contact the platform administrator before trying again.";
      }
      return input.hasActionUrl
        ? "Finish the connection on PayPal. After you return, refresh this status."
        : "If you left before completing approval, the owner who started the connection can confirm data sharing below to resume. Contact the platform administrator if that owner is unavailable.";
    case "revoked":
      return "PayPal Sandbox access was revoked for this shop. Confirm data sharing below to connect it again.";
    case "error":
      if (input.nextAction === "retry_status") {
        return "PayPal status could not be checked right now. Refresh the status in a moment.";
      }
      return "The previous connection attempt did not complete. Confirm data sharing below to start a new connection.";
    default:
      return null;
  }
}

export function deriveConnectionControls(input: {
  loading: boolean;
  shopId: string;
  shareDataConsent: boolean;
  connection: ConnectionResponse | null;
  actionUrl: string | null;
}) {
  const currentStatus = input.connection?.connection.status;
  const nextAction = input.connection?.connection.nextAction;
  const continueUrl =
    currentStatus === "pending" && nextAction !== "contact_support"
      ? input.actionUrl
      : null;
  const startBlockedByAction =
    nextAction === "contact_support" || nextAction === "retry_status";
  const canStart = Boolean(
    input.shopId &&
      input.shareDataConsent &&
      input.connection?.configured &&
      currentStatus !== "ready" &&
      !startBlockedByAction,
  );
  const showConnectionForm = Boolean(
    !input.loading &&
      input.connection?.configured &&
      currentStatus !== "ready" &&
      !startBlockedByAction &&
      !continueUrl,
  );
  const actionButtonLabel =
    currentStatus === "pending"
      ? "Resume sandbox connection"
      : "Start sandbox connection";
  const busyButtonLabel =
    currentStatus === "pending" ? "Resuming connection" : "Starting connection";

  return {
    currentStatus,
    nextAction,
    continueUrl,
    canStart,
    showConnectionForm,
    actionButtonLabel,
    busyButtonLabel,
    guidance:
      !input.loading && input.connection?.configured && currentStatus
        ? statusGuidance({
            status: currentStatus,
            nextAction,
            hasActionUrl: Boolean(continueUrl),
          })
        : null,
  };
}

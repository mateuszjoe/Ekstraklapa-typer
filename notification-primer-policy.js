export function notificationPrimerDecision({
  installedAndroidApp = false,
  launchedFromNotification = false,
  userReady = false,
  participantReady = false,
  supported = false,
  permission = "default",
  channelState = "disabled",
  busy = false,
  dismissedThisLaunch = false,
  recentlyDismissed = false,
  otherDialogOpen = false
} = {}) {
  if (launchedFromNotification) return { show: false, retry: false, reason: "notification-route" };
  if (!userReady || !participantReady) return { show: false, retry: false, reason: "inactive-player" };
  if (!supported) return { show: false, retry: false, reason: "unsupported" };
  if (channelState === "enabled") return { show: false, retry: false, reason: "enabled" };
  if (dismissedThisLaunch) return { show: false, retry: false, reason: "dismissed-this-launch" };
  if (!installedAndroidApp && permission === "denied") return { show: false, retry: false, reason: "denied-on-web" };
  if (!installedAndroidApp && recentlyDismissed) return { show: false, retry: false, reason: "cooldown" };
  if (busy || otherDialogOpen) return { show: false, retry: true, reason: "temporarily-blocked" };
  return { show: true, retry: false, reason: installedAndroidApp ? "android-app-inactive" : "web-inactive" };
}

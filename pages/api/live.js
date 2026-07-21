export default function handler(_request, response) {
  response.status(200).json({
    configured: false,
    provider: "api-football",
    mode: "not-configured",
    updatedAt: null,
    scheduleUpdatedAt: null,
    nextPollAt: null,
    pollIntervalSeconds: 360,
    quota: {
      usedToday: 0,
      localBudget: 95,
      providerLimit: 100,
      providerRemaining: null
    },
    error: null,
    fixtures: []
  });
}

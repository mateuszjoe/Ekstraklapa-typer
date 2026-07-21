const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  }
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/live") {
      return json({
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

    if (env?.ASSETS?.fetch) return env.ASSETS.fetch(request);
    return new Response("Nie znaleziono", { status: 404 });
  }
};

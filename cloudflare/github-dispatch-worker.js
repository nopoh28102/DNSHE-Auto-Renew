/**
 * DNSHE Auto Renew dispatcher — Cloudflare Cron -> GitHub Actions.
 *
 * DNSHE API does not respond reliably to requests from this Cloudflare Worker
 * (HTTP 520). GitHub-hosted runners can connect and have already passed a live
 * authenticated read-only DNSHE API test.
 *
 * The Worker never handles DNSHE credentials and has NO HTTP dispatch endpoint.
 * The only privileged operation is GitHub Actions workflow_dispatch using a
 * fine-grained token with Actions:write for DNSHE-Auto-Renew only.
 */
const TARGET = "nopoh28102/DNSHE-Auto-Renew";
const WORKFLOW = "renew.yml";
const REF = "main";
const API = `https://api.github.com/repos/${TARGET}/actions/workflows/${WORKFLOW}/dispatches`;

async function dispatch(env) {
  const token = env.GITHUB_WORKFLOW_TOKEN;
  if (!token || typeof token !== "string" || !token.trim()) {
    throw new Error("GITHUB_WORKFLOW_TOKEN missing; dispatch not attempted");
  }
  let response;
  try {
    response = await fetch(API, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "DNSHE-Auto-Renew-Cloudflare-Scheduler",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ref: REF}),
      signal: AbortSignal.timeout(20000)
    });
  } catch (e) {
    throw new Error("GitHub dispatch network failure: " + String(e?.name || "NetworkError"));
  }
  // GitHub can return either 204 No Content or 200 with the created run details.
  // Never log response content or tokens, including on errors.
  if (response.status !== 204 && response.status !== 200) {
    throw new Error("GitHub workflow_dispatch rejected, HTTP " + response.status);
  }
  console.log(JSON.stringify({event:"dnshe_github_dispatch",status:"accepted",repo:TARGET,workflow:WORKFLOW}));
}

export default {
  async fetch(request, env) {
    if (request.method === "GET" && new URL(request.url).pathname === "/health") {
      return Response.json({
        service: "dnshe-github-dispatch",
        mode: "cloudflare-cron-to-github-actions",
        configured: Boolean(env.GITHUB_WORKFLOW_TOKEN),
        workflow: TARGET + "/actions/workflows/" + WORKFLOW
      }, {headers: {"Cache-Control": "no-store"}});
    }
    return new Response("Not found", {status:404});
  },
  async scheduled(_event, env) {
    await dispatch(env);
  }
};

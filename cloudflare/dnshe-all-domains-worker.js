/*
 * DNSHE automatic free-domain renewal for every subdomain in the account.
 * Cloudflare Workers Cron; credentials are inherited secret bindings.
 * Supports Cloudflare Workers Free's 50 outbound subrequests per invocation.
 * Official DNSHE API: https://my.dnshe.com/knowledgebase/13/
 */
const API_BASE = "https://api005.dnshe.com/index.php?m=domain_hub";
const MAX_OUTBOUND_REQUESTS = 48;  // Free plan limit 50; reserve a safety margin.
const PAGE_SIZE = 500;
const MAX_PAGES = 20;
const FREE_RENEW_DAYS = 170; // Safely inside the 180-day free renewal window.
const MIN_API_INTERVAL_MS = 2150; // DNSHE standard limit: 30/min.
const TZ_SUFFIX = "+08:00"; // DNSHE sends local timestamps without a timezone.
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class RenewalError extends Error {
  constructor(code) { super(code); this.name = "RenewalError"; }
}
function truthValue(raw) {
  if (raw === true || raw === 1 || raw === "1") return true;
  if (raw === false || raw === 0 || raw === "0" || raw === null || raw === undefined) return false;
  const val = String(raw).trim().toLowerCase();
  if (["true", "yes"].includes(val)) return true;
  if (["false", "no", ""].includes(val)) return false;
  throw new RenewalError("unknown_permanent_flag");
}
function domainName(row) {
  const full = String(row.full_domain || "").trim().toLowerCase().replace(/\.$/, "");
  if (full) return full;
  const sub = String(row.subdomain || "").trim().toLowerCase().replace(/\.$/, "");
  const root = String(row.rootdomain || "").trim().toLowerCase().replace(/^\./, "");
  if (!sub || !root) return "";
  return sub.endsWith("." + root) ? sub : sub + "." + root;
}
function readDate(value) {
  if (typeof value !== "string" || !value.trim()) throw new RenewalError("missing_expiry");
  const valueTrimmed = value.trim();
  const iso = valueTrimmed.replace(" ", "T");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(iso))
    throw new RenewalError("invalid_expiry_format");
  const millis = Date.parse(iso + TZ_SUFFIX);
  if (!Number.isFinite(millis)) throw new RenewalError("invalid_expiry_value");
  return millis;
}
function statusOf(row, now = Date.now()) {
  if (truthValue(row.never_expires)) return {result:"permanent", eligible:false};
  const status = String(row.status || "").trim().toLowerCase();
  if (!["active", "registered"].includes(status)) return {result:"inactive", eligible:false, status};
  const expiry = readDate(row.expires_at);
  const daysRemaining = (expiry - now) / 86400000;
  if (daysRemaining <= 0) return {result:"expired", eligible:false, daysRemaining:0};
  if (daysRemaining > FREE_RENEW_DAYS)
    return {result:"not_due", eligible:false, daysRemaining:Math.ceil(daysRemaining)};
  return {result:"due", eligible:true, daysRemaining:Math.ceil(daysRemaining), expiry};
}
class DnsheClient {
  constructor(env) {
    if (!env.DNSHE_API_KEY || !env.DNSHE_API_SECRET) throw new RenewalError("missing_dnshe_secrets");
    this.key = env.DNSHE_API_KEY;
    this.secret = env.DNSHE_API_SECRET;
    this.requests = 0;
    this.lastCall = 0;
  }
  async call(action, params={}, method="GET") {
    if (this.requests >= MAX_OUTBOUND_REQUESTS) throw new RenewalError("free_plan_subrequest_budget_exhausted");
    const wait = Math.max(0, MIN_API_INTERVAL_MS - (Date.now() - this.lastCall));
    if (wait) await sleep(wait);
    this.lastCall = Date.now();
    this.requests++;
    const url = new URL(API_BASE);
    url.searchParams.set("endpoint", "subdomains");
    url.searchParams.set("action", action);
    if (method === "GET") for (const [k,v] of Object.entries(params)) url.searchParams.set(k, String(v));
    let response;
    try {
      response = await fetch(url.toString(), {
        method,
        headers: {
          "X-API-Key": this.key,
          "X-API-Secret": this.secret,
          "Accept": "application/json",
          ...(method === "POST" ? {"Content-Type":"application/json"} : {}),
        },
        ...(method === "POST" ? {body:JSON.stringify(params)} : {}),
        redirect:"error",
        signal:AbortSignal.timeout(25000),
      });
    } catch (_e) {
      // Do not print request headers or response text: credentials stay private.
      throw new RenewalError("dnshe_network_failure");
    }
    let data;
    try { data = await response.json(); }
    catch (_e) { throw new RenewalError("dnshe_not_json"); }
    if (!response.ok || !data || data.success !== true) {
      const code = typeof data?.error_code === "string" ? data.error_code.replace(/[^a-zA-Z0-9_]/g, "").slice(0,60) : "request_failed";
      if (action === "renew" && code === "renewal_not_yet_available")
        return {success:false, benignSkip:true, error_code:code};
      throw new RenewalError("dnshe_" + code + "_http_" + response.status);
    }
    return data;
  }
  async allDomains() {
    const domains = new Map();
    let expectedTotal = null;
    let complete = false;
    for (let page=1; page<=MAX_PAGES; page++) {
      const data = await this.call("list", {
        page, per_page:PAGE_SIZE, include_total:page===1 ? 1 : 0,
        fields:"id,subdomain,rootdomain,full_domain,status,expires_at,never_expires",
        sort_by:"id", sort_dir:"desc"
      });
      if (!Array.isArray(data.subdomains)) throw new RenewalError("list_missing_subdomains");
      if (page === 1 && Number.isInteger(Number(data.pagination?.total)))
        expectedTotal = Number(data.pagination.total);
      for (const row of data.subdomains) {
        const id=Number(row?.id);
        if (!Number.isSafeInteger(id) || id<=0 || !domainName(row))
          throw new RenewalError("invalid_list_domain_identity");
        if (domains.has(id)) throw new RenewalError("duplicated_domain_page");
        domains.set(id,row);
      }
      const pagination=data.pagination;
      if (pagination && typeof pagination.has_more === "boolean") {
        if (!pagination.has_more) { complete=true; break; }
        if (Number(pagination.next_page)!==page+1) throw new RenewalError("invalid_pagination");
      } else if (data.subdomains.length<PAGE_SIZE) {
        complete=true; break;
      } else {
        throw new RenewalError("pagination_missing_on_full_page");
      }
    }
    // Never make writes when the account listing is incomplete.
    if (!complete) throw new RenewalError("max_pages_reached_before_end");
    if (expectedTotal !== null && domains.size!==expectedTotal) throw new RenewalError("domain_total_mismatch");
    return [...domains.values()];
  }
}
async function runAll(env, {dryRun=false}={}) {
  const client=new DnsheClient(env);
  // Perform entire listing first. Fail closed on list/pagination problems.
  const domains=await client.allDomains();
  const summary={total:domains.length, renewed:[], notDue:0, permanent:0, inactive:0, expired:[], invalid:[], errors:[], deferred:[], requests:0};
  const due=[];
  for (const row of domains) {
    const name=domainName(row);
    try {
      const check=statusOf(row);
      if (check.eligible) due.push({id:Number(row.id),name,expiry:check.expiry,original:row});
      else if (check.result==="not_due") summary.notDue++;
      else if (check.result==="permanent") summary.permanent++;
      else if (check.result==="inactive") summary.inactive++;
      else if (check.result==="expired") summary.expired.push(name);
    } catch (e) {
      summary.invalid.push({domain:name,code:e instanceof RenewalError?e.message:"invalid_row"});
    }
  }
  // Prioritize domains closest to expiry so rate limits cannot hide urgent renewals.
  due.sort((a,b)=>a.expiry-b.expiry);
  for (const item of due) {
    if (dryRun) {summary.deferred.push(item.name); continue;}
    // Two API requests per due domain: read back details + POST renewal.
    if (client.requests > MAX_OUTBOUND_REQUESTS-2) {
      summary.deferred.push(item.name);
      continue;
    }
    try {
      const response=await client.call("get",{subdomain_id:item.id});
      const detail=response.subdomain;
      if (!detail || Number(detail.id ?? item.id)!==item.id || domainName(detail)!==item.name)
        throw new RenewalError("domain_details_mismatch");
      // Never renew a previously permanent domain when APIs disagree.
      if (truthValue(item.original.never_expires) || truthValue(detail.never_expires))
        throw new RenewalError("permanence_mismatch_manual_review");
      const current={...item.original,...detail};
      const check=statusOf(current);
      if (!check.eligible) { summary.deferred.push(item.name); continue; }
      const renewal=await client.call("renew",{subdomain_id:item.id},"POST");
      if (renewal.benignSkip) {summary.deferred.push(item.name);continue;}
      if (Number(renewal.subdomain_id)!==item.id) throw new RenewalError("renewal_id_mismatch");
      if (renewal.charged_amount===null || renewal.charged_amount===undefined || Number(renewal.charged_amount)!==0)
        throw new RenewalError("unexpected_charge_verify_dnshe_billing");
      if (readDate(renewal.new_expires_at) <= readDate(current.expires_at))
        throw new RenewalError("renewal_date_not_extended");
      summary.renewed.push({domain:item.name,expiresAt:renewal.new_expires_at});
    } catch (error) {
      const code=error instanceof RenewalError?error.message:"unexpected_failure";
      summary.errors.push({domain:item.name,code});
      if (code==="unexpected_charge_verify_dnshe_billing" || code==="free_plan_subrequest_budget_exhausted")
        break; // Do not risk additional charge on other domains.
    }
  }
  summary.requests=client.requests;
  console.log(JSON.stringify({event:"dnshe_all_domain_summary",dryRun,...summary}));
  // Force a failed Cron result so it is visible in Cloudflare's event logs.
  if (summary.errors.length || summary.invalid.length || summary.expired.length || (summary.deferred.length && !dryRun))
    throw new RenewalError("dnshe_attention_required_check_logs");
  return summary;
}
export default {
  async fetch(request) {
    if (new URL(request.url).pathname === "/health")
      return Response.json({service:"dnshe-all-domains-renew",schedule:"17 3 * * *",status:"configured",scope:"all_account_domains"});
    return new Response("Not found",{status:404});
  },
  async scheduled(_event, env) {
    await runAll(env);
  }
};

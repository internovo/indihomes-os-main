/**
 * check-meta-leads.cjs
 * ---------------------------------------------------------------------------
 * Answers one question definitively, straight from Meta's Graph API:
 *
 *     "Did Meta actually create any lead-ads leads after <date>?"
 *
 * CSV exports from Business Suite have been ambiguous about their date range,
 * so this asks the API directly instead. It is READ ONLY - it fetches and
 * prints, and writes nothing anywhere.
 *
 * Your token never leaves your machine: it is read from this repo's own .env
 * via META_PAGE_ACCESS_TOKEN, exactly like the server does.
 *
 * RUN IT FROM THE REPO ROOT:
 *     cd C:\Users\admin\Downloads\indihomes-os-restructured_1
 *     node check-meta-leads.cjs
 *
 * Optional: change the cutoff date
 *     node check-meta-leads.cjs 2026-08-15
 * ---------------------------------------------------------------------------
 */

try { require("dotenv").config(); } catch (_) {}

const metaClient = require("./backend/meta-client.cjs");

const SINCE_DATE = process.argv[2] || "2026-08-18";
const sinceEpoch = Math.floor(new Date(`${SINCE_DATE}T00:00:00+05:30`).getTime() / 1000);

function istStamp(iso) {
  // Meta returns created_time already offset for the ad account's timezone
  return String(iso || "").replace("T", " ").replace("+05:30", " IST");
}

async function main() {
  console.log("");
  console.log("Meta lead check");
  console.log("===============");
  console.log(`Cutoff        : ${SINCE_DATE} 00:00 IST  (epoch ${sinceEpoch})`);
  console.log(`Token present : ${metaClient.isConfigured() ? "yes" : "NO - META_PAGE_ACCESS_TOKEN is not set"}`);
  console.log(`Page ID       : ${process.env.META_PAGE_ID || "(not set)"}`);
  console.log(`Graph version : ${process.env.META_GRAPH_VERSION || "v21.0 (default)"}`);
  console.log("");

  if (!metaClient.isConfigured()) {
    console.error("Cannot continue without META_PAGE_ACCESS_TOKEN. Run this from the repo root so .env is picked up.");
    process.exit(1);
  }

  let forms;
  try {
    forms = await metaClient.listForms();
  } catch (e) {
    console.error("FAILED to list forms from Meta.");
    console.error("  " + e.message);
    console.error("");
    console.error("If this says 'Error validating access token' or 'insufficient privileges',");
    console.error("the token is dead or lacks leads_retrieval on this Page - that alone is a finding.");
    process.exit(1);
  }

  console.log(`Forms on this Page with at least 1 lead: ${forms.length}`);
  console.log("");

  let grandTotal = 0;
  const withNew = [];

  for (const form of forms) {
    let leads;
    try {
      leads = await metaClient.listLeadsForForm(form.id, sinceEpoch);
    } catch (e) {
      console.log(`  [!] ${form.name} (${form.id}) - FAILED: ${e.message}`);
      continue;
    }

    // Meta's own test-lead submissions come through with dummy field values.
    const real = leads.filter(l =>
      !(l.field_data || []).some(f => String((f.values || [])[0] || "").startsWith("<test lead:"))
    );
    const testCount = leads.length - real.length;

    grandTotal += real.length;
    if (real.length || testCount) {
      withNew.push({ form, real, testCount });
    }
  }

  if (!withNew.length) {
    console.log(`No leads of any kind since ${SINCE_DATE} across all ${forms.length} forms.`);
  } else {
    for (const { form, real, testCount } of withNew) {
      console.log(`FORM: ${form.name}`);
      console.log(`      id ${form.id}  ·  lifetime leads ${form.leads_count ?? "?"}`);
      console.log(`      real leads since ${SINCE_DATE}: ${real.length}${testCount ? `  (plus ${testCount} test lead${testCount > 1 ? "s" : ""}, ignored)` : ""}`);
      real
        .slice()
        .sort((a, b) => String(b.created_time).localeCompare(String(a.created_time)))
        .forEach(l => console.log(`        ${istStamp(l.created_time)}   lead id ${l.id}`));
      console.log("");
    }
  }

  console.log("--------------------------------------------");
  console.log(`TOTAL real leads at Meta since ${SINCE_DATE}: ${grandTotal}`);
  console.log("--------------------------------------------");
  console.log("");
  console.log("How to read this:");
  console.log("  Leads listed for 20-21 Aug  -> Meta created them, your CRM never got them.");
  console.log("                                 The delivery path is broken. They are recoverable.");
  console.log("  Nothing for 20-21 Aug       -> Meta never created any. The ads stopped producing");
  console.log("                                 leads, and there is nothing wrong with the backend.");
  console.log("");
}

main().catch(e => {
  console.error("Unexpected failure:", e);
  process.exit(1);
});

/**
 * Integration test — Crystal Roof affluence API availability check.
 *
 * ⚠️  Crystal Roof is a TEMPORARY data source (see fetchCrystalRoof() in govuk.js).
 * The API is currently unauthenticated, but this is undocumented behaviour that
 * could change at any time. This test exists to catch breakage at deploy time.
 *
 * Run manually:
 *   node functions/research/test-crystal-roof-api.mjs
 *
 * Add to CI — run on every push to master (example for a shell-based pipeline):
 *   node functions/research/test-crystal-roof-api.mjs || (echo "Crystal Roof API broken — see TECH DEBT in govuk.js" && exit 1)
 *
 * Exit codes:
 *   0 — API responded with the expected shape (qualificationOa + occupationOa + income)
 *   1 — API failed or returned unexpected shape (shape has changed / auth added)
 *
 * When this test fails in CI it is a reminder to implement the Nomis replacement.
 * See govuk.js fetchCrystalRoof() for the production plan.
 */

const TEST_POSTCODE = 'SW1A1AA';   // Buckingham Palace area — stable, always has data
const API_URL       = `https://crystalroof.co.uk/data-api/affluence/postcode/v2/${TEST_POSTCODE}`;
const TIMEOUT_MS    = 10_000;

const REQUIRED_FIELDS = [
  'qualificationOa',
  'occupationOa',
  'householdIncomeMsoa',
];

const REQUIRED_QUAL_KEYS   = ['noQualifications', 'level4andAbove', 'total'];
const REQUIRED_OCC_KEYS    = ['managerialAdministrativeAndProfessional', 'routineAndManual', 'total'];
const REQUIRED_INCOME_KEYS = ['totalAnnualIncome'];

console.log(`\n🔍 Crystal Roof API health check — ${API_URL}\n`);

let data;
try {
  const res = await fetch(API_URL, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'User-Agent': 'Mozilla/5.0 (integration-test)' },
  });

  if (!res.ok) {
    console.error(`❌ HTTP ${res.status} — API returned an error response.`);
    if (res.status === 401 || res.status === 403) {
      console.error('   Auth has been added to this endpoint. Implement the Nomis replacement (see govuk.js).');
    }
    process.exit(1);
  }

  const json = await res.json();
  data = json?.data;

  if (!data) {
    console.error('❌ Response parsed but "data" field is missing — API shape has changed.');
    process.exit(1);
  }
} catch (err) {
  if (err.name === 'TimeoutError') {
    console.error(`❌ Timeout after ${TIMEOUT_MS}ms — API is unreachable or very slow.`);
  } else {
    console.error(`❌ Fetch failed: ${err.message}`);
  }
  process.exit(1);
}

let allOk = true;

// Check top-level fields
for (const field of REQUIRED_FIELDS) {
  if (!data[field]) {
    console.error(`❌ Missing top-level field: data.${field}`);
    allOk = false;
  } else {
    console.log(`✅ data.${field} present`);
  }
}

// Spot-check nested keys
const checkKeys = (obj, keys, path) => {
  for (const k of keys) {
    if (obj[k] == null) {
      console.error(`❌ Missing key: ${path}.${k}`);
      allOk = false;
    }
  }
};

if (data.qualificationOa)    checkKeys(data.qualificationOa,    REQUIRED_QUAL_KEYS,   'qualificationOa');
if (data.occupationOa)       checkKeys(data.occupationOa,       REQUIRED_OCC_KEYS,    'occupationOa');
if (data.householdIncomeMsoa) checkKeys(data.householdIncomeMsoa, REQUIRED_INCOME_KEYS, 'householdIncomeMsoa');

if (allOk) {
  console.log('\n✅ Crystal Roof API is healthy and response shape is as expected.\n');
  process.exit(0);
} else {
  console.error('\n❌ Shape validation failed — check logs above.');
  console.error('   This is a TEMP data source. Now is a good time to implement the Nomis replacement.\n');
  process.exit(1);
}

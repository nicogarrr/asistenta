// What a job posting is: its likely roles, the level its title names, the years
// of experience its text asks for, the Spanish regions its location names and
// the skills, tools, industries and spoken languages its text names.
//
// Shared by scripts/jobs.mjs, which stores these in /api/v1/jobs.json when it
// crawls (the description is read there and never stored), and api/mcp.js,
// which filters on them and works them out itself, from the title and the
// location, for a posting stored before they existed. Not a Vercel Function:
// files starting with _ in api/ are not served.

export const norm = (text) => String(text ?? "").normalize("NFKD").replace(/[^\x00-\x7f]/g, "")
  .toLowerCase().replace(/-/g, " ").split(/\s+/).filter(Boolean).join(" ");

// Lowercase ASCII words: accents, case and punctuation do not matter. Keeps +
// and # so c++ and c# stay apart from c. Spanish titles name both genders
// ("Ingeniero/a", "Jefe/a", "Delegad@"): the first form stands for both.
export const words = (text) => norm(text)
  .replace(/([a-z])\s*\/\s*(?:a|as|ra|ras)\b/g, "$1").replace(/([a-z])\s*\((?:a|as)\)/g, "$1")
  .replace(/([a-z])@/g, "$1o")
  .replace(/[^a-z0-9+#]+/g, " ").trim();

// --- Places --------------------------------------------------------------------------

// Other names of a region (and the Basque provinces, the only ones named
// unlike their capital or their region), and its main cities; "/" joins names of one city,
// and the first is the one reported back.
export const REGION_NAMES = {
  AN: "Andalucía, Andalusia", AR: "Aragón, Aragon", AS: "Asturias", CB: "Cantabria",
  CE: "Ceuta", CL: "Castilla y León, Castile and León", CM: "Castilla La Mancha, Castile La Mancha",
  CN: "Canary Islands, Canarias", CT: "Catalunya, Catalonia, Cataluña", EX: "Extremadura",
  GA: "Galicia", IB: "Balearic Islands, Illes Balears, Islas Baleares, Baleares",
  MD: "Madrid, Comunidad de Madrid, Community of Madrid", ML: "Melilla",
  MU: "Murcia, Región de Murcia, Region of Murcia", NC: "Navarra, Navarre",
  PV: "Euskadi, Basque Country, País Vasco, Gipuzkoa, Guipúzcoa, Bizkaia, Vizcaya, Biscay, Álava, Araba", RI: "La Rioja",
  VC: "Comunidad Valenciana, Comunitat Valenciana, Valencian Community, C. Valenciana",
};
export const CITIES = {
  AN: "Sevilla/Seville, Málaga, Granada, Córdoba, Cádiz, Almería, Huelva, Jaén, Jerez, Marbella",
  AR: "Zaragoza, Huesca, Teruel", AS: "Oviedo, Gijón", CB: "Santander", CE: "Ceuta",
  CL: "Valladolid, León, Burgos, Salamanca, Segovia, Ávila, Soria, Palencia, Zamora",
  CM: "Toledo, Albacete, Ciudad Real, Cuenca, Guadalajara",
  CN: "Las Palmas/Las Palmas de Gran Canaria, Santa Cruz de Tenerife, Tenerife, Gran Canaria",
  CT: "Barcelona, Girona/Gerona, Lleida/Lérida, Tarragona, Sabadell, Terrassa, Sant Cugat/Sant Cugat del Vallès",
  EX: "Badajoz, Cáceres, Mérida",
  GA: "A Coruña/La Coruña/Coruña, Vigo, Santiago de Compostela/Santiago, Pontevedra, Lugo, Ourense",
  IB: "Palma/Palma de Mallorca, Mallorca/Majorca, Ibiza/Eivissa, Menorca",
  MD: "Alcobendas, Las Rozas, Pozuelo/Pozuelo de Alarcón, Getafe, Tres Cantos",
  ML: "Melilla", MU: "Cartagena", NC: "Pamplona/Iruña",
  PV: "Bilbao, San Sebastián/Donostia/Donostia-San Sebastián, Vitoria/Vitoria-Gasteiz/Gasteiz",
  RI: "Logroño", VC: "Valencia/València, Alicante/Alacant, Castellón/Castelló, Elche/Elx",
};
const split = (text, sep) => String(text ?? "").split(sep).map((x) => x.trim()).filter(Boolean);
export const plainWords = (text) => norm(text).replace(/[^a-z0-9]+/g, " ").trim();
// Every place name as [words, region code, city or null].
export const PLACES = [
  ...Object.entries(REGION_NAMES).flatMap(([code, names]) => split(names, ",").map((n) => [n, code, null])),
  ...Object.entries(CITIES).flatMap(([code, list]) => split(list, ",").flatMap((group) =>
    split(group, "/").map((n) => [n, code, split(group, "/")[0]]))),
].map(([name, code, city]) => [plainWords(name), code, city]);
// The names of one city, or of every place in a region, as found in a location.
export const placeNames = (code, city) =>
  PLACES.filter(([, c, ci]) => c === code && (!city || ci === city)).map(([n]) => n);

const hasPhrase = (haystack, phrase) => ` ${haystack} `.includes(` ${phrase} `);

// The region codes a location names, by region or city, in the order of PLACES.
export function regionsOf(location) {
  const where = words(location);
  if (!where) return [];
  const found = new Set();
  for (const [name, code] of PLACES) if (name && hasPhrase(where, name)) found.add(code);
  return [...found];
}

// --- Roles ---------------------------------------------------------------------------

// Engineering that is not software: a bare "engineer" in a title with one of
// these, and none of SOFTWARE, is not a software engineer (Airbus's "Landing
// Gear Engineer" got software medians when every engineer was one).
const PHYSICAL = /\b(aerospace|aeronaut\w*|aerodynamics?|aircraft|airframe|landing gear|propulsion|avionics|flight|stress|structures?|structural|estructur\w*|mechanical|mecanic\w*|manufactur\w*|industri\w*|process|procesos|production|produccion|maintenance|mantenimiento|chemical|quimic\w*|civil|electric\w*|hvac|climatiz\w*|installation|instalacion\w*|field service|quality|calidad|materials?|materiales|thermal|piping|plant|planta|construction|construccion|obra|mining|petroleum|naval|nuclear|automotive|automocion|rail|ferroviari\w*|telecom\w*|rf|hardware|electronic\w*|optical|photonics|biomedical|clinical|energ\w*|renovables|solar|eolic\w*|subestacion\w*|alta tension|aeropuertos?)\b/;
const SOFTWARE = /\b(software|backend|frontend|front end|back end|full ?stack|web|mobile|ios|android|data|ml|machine learning|ai|cloud|devops|sre|platform|infrastructure|security|qa|test automation|automation|sdet|api|java|python|golang|go|javascript|typescript|react|node|kotlin|scala|ruby|php|net|c\+\+|c#|rust|firmware|embedded|site reliability|systems?|network|database|salesforce|sap|integration|solutions?|applications?|computer vision|llm|genai|analytics|bi|developer|deployed)\b/;

const NOT_SOFTWARE = { test: (t) => PHYSICAL.test(t) && !SOFTWARE.test(t) };

// A posting's roles, from its title, in data.json's role vocabulary. Every
// entry that matches counts, in this order: the narrower titles come first
// ("Sales Engineer" before software-engineer). Each entry is [slug, pattern,
// unless]; patterns read words(title).
export const ROLE_TITLES = [
  ["sales-engineer", /\b(sales|solutions?|pre ?sales) engineering (manager|director|head|lead)\b/],
  ["software-engineering-manager", /\bengineering (manager|director|head)\b|\bmanager (i{1,3} )?(of )?(software |machine learning |ml |data |platform |backend |frontend |mobile |infrastructure )?engineering\b|\b(head|director|vp|vice president) (of )?(software |platform )?engineering\b|\bjefe de (desarrollo|ingenieria)\b/,
    /\b(sales|solutions?|pre ?sales|customer|field|manufacturing|process|quality) engineering\b/],
  ["data-science-manager", /\b(data science|machine learning|ml|analytics) (manager|director|head)\b|\b(head|director) of (data science|machine learning|analytics)\b/],
  ["technical-program-manager", /\btechnical program(me)? manager\b|\btpm\b/],
  ["program-manager", /\bprogram(me)? manager\b/],
  ["project-manager", /\bproject (manager|lead|coordinator)\b|\bscrum master\b|\bdelivery (manager|lead)\b|\bjefe de proyecto/],
  ["product-manager", /\bproduct (manager|owner|lead)\b|\b(head|director|vp) (of )?product\b/],
  ["ux-researcher", /\b(ux|user) research/],
  ["product-designer", /\bdesigner\b|\bdisenador/, NOT_SOFTWARE],
  ["sales-engineer", /\b(sales|solutions?|pre ?sales) engineer\b|\bsolutions? consultant\b/],
  ["solution-architect", /\barchitect\b|\barquitect[oa]\b/, NOT_SOFTWARE],
  ["security-analyst", /\bsecurity (analyst|specialist|operations)\b|\bsoc analyst\b|\bcyber ?security\b|\bcyber\b|\bciberseguridad\b/, /\b(marketing|sales|account|recruit\w*)\b/],
  ["data-scientist", /\bdata scien|\b(research|applied|applied ai|ai|machine learning|ml) scientist\b|\bcientifico de datos\b/],
  ["data-analyst", /\b(data|bi|business intelligence|analytics|product|marketing) analyst\b|\banalista de datos\b/],
  ["business-analyst", /\bbusiness analyst\b|\banalista de negocio/],
  ["financial-analyst", /\b(financial|finance|fp a) analyst\b/],
  ["legal", /\blegal\b|\bcounsel\b|\blawyer\b|\battorney\b|\bparalegal\b|\babogad[oa]\b|\bjurist/],
  ["aerospace-engineer", /\b(aerospace|aeronautic(al)?|aerodynamics?|aircraft|airframe|landing gear|propulsion|avionics|flight physics|flight test|stress|structures|airworthiness)\b.*\b(engineer|ingenier[oa])\b|\bingenier[oa] aeronautic/],
  ["civil-engineer", /\b(civil|structural|construction) engineer\b|\bingenier[oa] (civil|de caminos)/],
  ["electrical-engineer", /\belectrical (design )?engineer\b|\bingenier[oa] electric/],
  ["mechanical-engineer", /\bmechanical (design )?engineer|\bingenier[oa] mecanic/],
  ["hardware-engineer", /\b(hardware|electronics?|asic|fpga|rf)( design| test| validation| verification)? engineer\b|\bingenier[oa] electronic/],
  ["information-technologist", /\bit (support|specialist|technician|administrator|manager)\b|\bsys ?admin\b|\b(systems?|sap basis|database|db|network|linux|windows|openshift|salesforce|cloud) administrator\b|\badministrador\b|\bhelp ?desk\b|\btecnico (de )?(sistemas|soporte|it|helpdesk)\b/],
  ["customer-success", /\bcustomer success\b/],
  ["recruiter", /\brecruit(er|ing|ment)\b|\btalent (acquisition|partner|sourcer)\b|\bsourcer\b/],
  ["human-resources", /\bhr\b|\bhrbp\b|\bhuman resources\b|\bpeople (partner|operations|ops|business partner|manager|specialist)\b|\brecursos humanos\b|\bpayroll\b/],
  ["marketing-operations", /\bmarketing (operations|ops|automation)\b/],
  ["marketing", /\bmarketing\b|\bseo\b|\bcontent (manager|writer|strategist)\b|\bbrand (manager|designer|lead)\b|\bcommunications? (manager|lead|specialist)\b/],
  ["business-development", /\bbusiness development\b|\bpartnerships? (manager|lead|director)\b|\bbdr\b/],
  ["bizops-manager", /\b(business|biz) ?operations\b|\bbizops\b|\bstrategy (and |& )?operations\b/],
  ["accountant", /\baccount(ant|ing)\b|\bcontable\b|\bbookkeeper\b/],
  ["customer-service", /\bsupport (agent|specialist|engineer|associate|representative)\b|\bcustomer (service|care|support)\b/],
  // Catch-alls, counted only when nothing above matched.
  ["software-engineer", /\b(developer|programmer|sre|devops)\b|\bdesarrollador|\bprogramador|\bingenier[oa] (de )?(software|datos|sistemas|backend|frontend|devops|cloud|qa|ia)\b/],
  ["software-engineer", /\bengineer\b|\bingenier[oa]\b/, NOT_SOFTWARE],
  ["sales", /\bsales\b|\baccount (executive|manager|director)\b|\bsdr\b|\bventas\b|\bcomercial\b/],
  ["management-consultant", /\bconsultant\b|\bconsultor/],
];
const CATCH_ALL = new Set(["software-engineer", "sales", "management-consultant"]);
// The roles a title can be classified as, whatever data.json holds.
export const CLASSIFIED = new Set(ROLE_TITLES.map(([slug]) => slug));
export const MAX_ROLES = 3;

// The roles a title reads as, best first, among `known` (a Set of role slugs);
// empty when none fits. A catch-all counts only when nothing narrower did.
export function titleRoles(title, known) {
  const t = words(title);
  const out = [];
  for (const [slug, pattern, unless] of ROLE_TITLES) {
    if (out.includes(slug) || !known.has(slug) || (out.length && CATCH_ALL.has(slug))) continue;
    if (pattern.test(t) && !unless?.test(t)) out.push(slug);
  }
  return out.slice(0, MAX_ROLES);
}

// --- Level and experience ----------------------------------------------------------

// The level a title names, first match wins: "Senior Director" is head,
// "Senior Associate" senior. A title naming none has none; find_jobs reads
// that as mid. Manager is left out: product, account and project managers
// are roles, not levels.
export const SENIORITIES = ["intern", "junior", "mid", "senior", "staff", "lead", "head"];
const LEVEL_TITLES = [
  ["intern", /\b(intern|interns|internship|becari[oa]s?|becas?|practicas|trainee|apprentice|apprenticeship|working student|werkstudent)\b/],
  ["head", /\b(head|director|directora|vp|svp|evp|vice president|chief|cto|cio|ciso|cfo|coo|ceo|cmo|cpo)\b/],
  ["staff", /\b(staff|principal|distinguished|fellow)\b/],
  ["lead", /\b(lead|tech lead|team lead|leader|lider)\b/, /\blead (generation|gen)\b/],
  ["senior", /\b(senior|sr|snr|iii)\b/],
  ["junior", /\b(junior|jr|graduate|grad|entry level|new grad)\b/],
  ["mid", /\b(mid|mid level|intermediate|ii)\b/],
];

export function seniorityOf(title) {
  const t = words(title);
  for (const [level, pattern, unless] of LEVEL_TITLES) if (pattern.test(t) && !unless?.test(t)) return level;
  return null;
}

const NUMBERS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  un: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10 };
const N = `(\\d{1,2}|${Object.keys(NUMBERS).join("|")})`;
const RANGE = `\\s*(?:\\+|plus)?\\s*(?:(?:-|to|a)\\s*${N}\\s*)?\\+?\\s*`;
const FILLER = "(?:[a-z0-9+#/.,&()-]+\\s+){0,6}?";
// "5+ years of professional experience", "3-5 years' experience in", "al menos
// 3 años de experiencia", "experience of at least 4 years", "experiencia mínima
// de 2 años". An experience word must be near: "kept for 2 years" is not asked.
const YEARS = [
  new RegExp(`\\b${N}${RANGE}(?:years?|yrs?)\\s+(?:of\\s+)?${FILLER}(?:experience|expertise|track record|background|working)\\b`, "g"),
  new RegExp(`\\b${N}${RANGE}anos\\s+(?:de\\s+)?${FILLER}(?:experiencia|trabajando|desempenando)\\b`, "g"),
  // A "+", a range or "at least" says it is asked even with no experience word
  // ("5+ years in pricing", "3-5 years of commercial Python"); history never
  // carries one ("started 12 years ago", "15 years building").
  new RegExp(`\\b${N}\\s*\\+\\s*(?:years?|yrs?|anos)\\b`, "g"),
  new RegExp(`\\b${N}\\s*(?:-|to|a)\\s*${N}\\s*\\+?\\s*(?:years?|yrs?|anos)\\s+(?:of|in|de|en|as|como|working|leading|managing|building)\\b`, "g"),
  new RegExp(`\\b(?:at least|minimum(?: of)?|a minimum of|al menos|minimo(?: de)?)\\s+${N}\\s*(?:years?|yrs?|anos)\\b`, "g"),
  new RegExp(`\\bexperien(?:ce|cia)[\\s:,-]+(?:of\\s+|de\\s+)?(?:at least\\s+|minimum (?:of\\s+)?|a minimum of\\s+|minima (?:de\\s+)?|de al menos\\s+|al menos\\s+|mas de\\s+|over\\s+|more than\\s+)?${N}${RANGE}(?:years?|yrs?|anos)\\b`, "g"),
];
const count = (n) => n === undefined ? null : /^\d+$/.test(n) ? Number(n) : NUMBERS[n] ?? null;
// Above this a figure is the company's history ("over 20 years of
// experience in the market"), not what the posting asks.
const MAX_ASKED = 15;

// The years of experience a description asks for, as [min, max] (max null when
// open-ended), or null when it names none. Several figures: the highest
// minimum, the most the posting asks of anyone.
export function yearsAsked(text) {
  // norm() would turn "3-5 years" into "3 5 years": keep the hyphen here.
  const t = String(text ?? "").replace(/[‐-―−]/g, "-").replace(/[’']/g, " ")
    .normalize("NFKD").replace(/[^\x00-\x7f]/g, "").toLowerCase().replace(/\s+/g, " ");
  let best = null;
  for (const pattern of YEARS) {
    for (const m of t.matchAll(pattern)) {
      // "1.5+ years" is not 5, and "12 to 15+ years" is not 15.
      if (/(?:[\d.,]|\d\s*(?:-|to|a)\s*)$/.test(t.slice(Math.max(0, m.index - 8), m.index))) continue;
      const low = count(m[1]), high = count(m[2]);
      if (low === null || low > MAX_ASKED) continue;
      const max = high !== null && high > low && high <= 20 ? high : null;
      if (!best || low > best[0]) best = [low, max];
    }
  }
  return best;
}

// --- Way of working ------------------------------------------------------------------

export const REMOTE = /\b(remote|remoto|teletrabajo|anywhere)\b/;

// The posting's way of working; a null in the index is read from the location.
export function workplaceOf(job) {
  if (job.workplace) return job.workplace;
  const where = words(job.location);
  if (/\b(hybrid|hibrido)\b/.test(where)) return "hybrid";
  return REMOTE.test(where) ? "remote" : null;
}

// --- Skills and topics ---------------------------------------------------------------

// What a posting asks for or is about, from a fixed vocabulary: languages,
// frameworks, cloud, data and AI tools, security and compliance, industries,
// spoken languages. find_jobs' query matched titles only, and a stack almost
// never is in one: in November 2026 agents got 0 postings for angular, kotlin,
// "java spring" and "Django FastAPI", and 10 for python at 60k. jobs.mjs stores
// the ids it finds in the title and the description; the description itself
// is not kept, and an id is never text of the posting's own.
//
// Each entry is [id, forms, extra]. Forms are words() phrases, matched whole,
// a plural allowed, in the title and the description, and read in a query as
// the id. extra.query: more ways a query names it, too loose for a
// description ("go"). extra.cased: a pattern on the text with its case kept,
// for names that are also everyday words ("React", "Spring", "Go").
export const KEYWORDS = [
  // Languages
  ["python", ["python", "pyspark", "pandas", "numpy"]],
  ["java", ["java", "jvm", "j2ee", "jakarta ee"]],
  ["kotlin", ["kotlin"]],
  ["scala", ["scala"]],
  ["javascript", ["javascript", "ecmascript", "es6"], { query: ["js"] }],
  ["typescript", ["typescript"], { query: ["ts"] }],
  ["golang", ["golang"], { query: ["go"],
    // "in Go or Python", "Python, Go, Java"; never "Go-to-market" or "Go/No-Go".
    cased: /(?:[,(/]\s*|\b(?:in|and|or|using|with|like|as|of)\s+)Go\b(?![-/])(?!\s*(?:to|ahead|beyond|live|further|deeper|through|back|out|for|the)\b)|\bGo(?![-/]\s*(?:No|to)\b)\s*(?:[,)/]|\s+(?:and|or)\s+[A-Z]|\s+(?:developer|engineer|backend|services|microservices|code|codebase)\b)/ }],
  ["rust", ["rust", "rustlang"]],
  ["cpp", ["c++", "cpp"]],
  ["csharp", ["c#", "csharp"]],
  ["dotnet", ["dotnet", "asp net", "net core", "net framework", "blazor"], { query: ["net", "asp"], cased: /\.NET\b/ }],
  ["php", ["php"]],
  ["ruby", ["ruby"]],
  ["rails", ["rails", "ruby on rails", "ror"]],
  ["elixir", ["elixir", "phoenix framework"]],
  ["erlang", ["erlang"]],
  ["clojure", ["clojure"]],
  ["haskell", ["haskell"]],
  ["swift", ["swift", "swiftui"]],
  ["objective-c", ["objective c", "objc"]],
  ["dart", ["dart"]],
  ["sql", ["sql", "t sql", "pl sql", "plsql", "tsql"]],
  ["nosql", ["nosql"]],
  ["bash", ["bash", "shell scripting"]],
  ["solidity", ["solidity"]],
  ["abap", ["abap"]],
  ["cobol", ["cobol"]],
  ["matlab", ["matlab", "simulink"]],
  // Front end and mobile
  ["react", ["reactjs", "react js", "react hooks", "react query"], { query: ["react"], cased: /\bReact(?:JS|\.js)?\b(?! Native)/ }],
  ["react-native", ["react native"]],
  ["angular", ["angular", "angularjs", "rxjs", "ngrx"]],
  ["vue", ["vue", "vuejs", "vue js", "nuxt", "nuxtjs", "pinia"]],
  ["svelte", ["svelte", "sveltekit"]],
  ["nextjs", ["nextjs", "next js"]],
  ["redux", ["redux"]],
  ["html-css", ["html", "html5", "css", "css3", "sass", "scss"]],
  ["tailwind", ["tailwind", "tailwindcss"]],
  ["flutter", ["flutter"]],
  ["ios", ["ios", "uikit", "xcode"]],
  ["android", ["android", "jetpack compose"]],
  ["webgl", ["webgl", "three js", "threejs"]],
  ["figma", ["figma"]],
  ["design-systems", ["design system", "design systems"]],
  // Back end
  ["django", ["django"]],
  ["flask", ["flask"]],
  ["fastapi", ["fastapi"]],
  ["spring", ["spring boot", "springboot", "spring framework", "spring cloud"], { query: ["spring"], cased: /\bSpring\b/ }],
  ["nodejs", ["nodejs", "node js"], { query: ["node"], cased: /\bNode(?:JS|\.js)?\b/ }],
  ["nestjs", ["nestjs", "nest js"]],
  ["laravel", ["laravel"]],
  ["symfony", ["symfony"]],
  ["graphql", ["graphql", "apollo"]],
  ["grpc", ["grpc", "protobuf"]],
  ["microservices", ["microservices", "microservice", "micro services", "service oriented"]],
  ["kafka", ["kafka", "confluent"]],
  ["rabbitmq", ["rabbitmq"]],
  ["event-driven", ["event driven", "event sourcing", "cqrs"]],
  ["distributed-systems", ["distributed systems", "distributed system", "sistemas distribuidos"]],
  ["low-latency", ["low latency", "high frequency trading", "hft"]],
  // Cloud and operations
  ["aws", ["aws", "amazon web services", "ec2", "cloudformation"]],
  ["gcp", ["gcp", "google cloud", "google cloud platform", "bigquery"]],
  ["azure", ["azure"]],
  ["kubernetes", ["kubernetes", "k8s", "eks", "gke", "aks", "openshift", "helm charts"], { cased: /\bHelm\b/ }],
  ["docker", ["docker", "containers", "containerization", "containerisation"]],
  ["terraform", ["terraform", "terragrunt", "pulumi", "infrastructure as code", "iac"]],
  ["ansible", ["ansible", "puppet", "chef"]],
  ["linux", ["linux", "unix"]],
  ["ci-cd", ["ci cd", "cicd", "continuous integration", "continuous delivery", "continuous deployment", "github actions", "jenkins", "gitlab ci", "argocd", "argo cd"]],
  ["observability", ["observability", "prometheus", "grafana", "datadog", "opentelemetry", "new relic", "splunk", "elk"]],
  ["devops", ["devops"]],
  ["sre", ["sre", "site reliability"]],
  ["serverless", ["serverless", "aws lambda", "cloud functions"]],
  ["networking", ["tcp ip", "bgp", "network engineering", "networking protocols", "sdn"]],
  ["embedded", ["embedded", "firmware", "rtos", "microcontrollers", "embebido"]],
  ["fpga", ["fpga", "vhdl", "verilog", "asic"]],
  ["kernel", ["linux kernel", "kernel", "ebpf"]],
  ["compilers", ["compiler", "compilers", "llvm", "mlir"]],
  ["gpu", ["gpu", "gpus", "cuda", "triton"]],
  ["hpc", ["hpc", "high performance computing", "supercomputing"]],
  ["test-automation", ["test automation", "automated testing", "cypress", "playwright", "selenium", "appium", "qa automation", "pruebas automatizadas", "sdet"]],
  // Data
  ["postgresql", ["postgresql", "postgres"]],
  ["mysql", ["mysql", "mariadb"]],
  ["mongodb", ["mongodb", "mongo"]],
  ["redis", ["redis"]],
  ["elasticsearch", ["elasticsearch", "opensearch", "elastic search", "solr"]],
  ["snowflake", ["snowflake"]],
  ["databricks", ["databricks", "delta lake"]],
  ["spark", ["apache spark", "pyspark", "spark sql", "spark streaming"], { query: ["spark"], cased: /\bSpark\b/ }],
  ["hadoop", ["hadoop", "hive"]],
  ["airflow", ["airflow", "dagster", "prefect"]],
  ["dbt", ["dbt"]],
  ["flink", ["flink"]],
  ["etl", ["etl", "elt", "data pipelines", "data pipeline"]],
  ["data-warehouse", ["data warehouse", "data warehousing", "data lake", "lakehouse", "redshift"]],
  ["bi", ["business intelligence", "power bi", "powerbi", "tableau", "looker", "qlik", "metabase"]],
  ["excel", ["vba", "google sheets"], { cased: /\bExcel\b/ }],
  ["sap", ["sap", "s 4hana", "s4hana", "hana", "fiori"]],
  ["sap-analytics", ["datasphere", "sap analytics cloud", "sap bw", "bw 4hana", "sap bi", "sac planning"], { query: ["sac"] }],
  ["salesforce", ["salesforce", "apex", "sfdc"]],
  ["dynamics", ["dynamics 365", "microsoft dynamics", "dynamics crm"]],
  ["servicenow", ["servicenow"]],
  ["odoo", ["odoo"]],
  // Machine learning and AI
  ["ai", ["ai", "artificial intelligence", "ia", "inteligencia artificial"]],
  ["machine-learning", ["machine learning", "ml", "aprendizaje automatico", "scikit learn", "xgboost"]],
  ["deep-learning", ["deep learning", "neural networks", "neural network", "transformers"]],
  ["pytorch", ["pytorch"]],
  ["tensorflow", ["tensorflow", "keras"]],
  ["llm", ["llm", "llms", "large language model", "large language models", "genai", "gen ai", "generative ai",
           "ia generativa", "rag", "retrieval augmented generation", "prompt engineering", "fine tuning", "langchain",
           "llamaindex", "openai", "gpt"]],
  ["ai-agents", ["ai agents", "ai agent", "agentic", "llm agents", "multi agent", "autonomous agents", "mcp"]],
  // "chatbot" and "n8n" found nothing on 2026-11-12, in junior AI searches. Not "voice agent":
  // one company's every posting, sales included, says it sells them.
  ["conversational-ai", ["chatbot", "chat bot", "conversational ai", "conversational agent", "conversational design",
                         "conversational interface", "dialogflow"]],
  ["workflow-automation", ["n8n", "zapier", "workflow automation", "power automate", "uipath", "rpa",
                           "robotic process automation"]],
  ["low-code", ["low code", "no code", "lowcode", "nocode"]],
  // Not bare "inference": statistics has its own.
  ["inference", ["model inference", "llm inference", "inference optimization", "inference serving", "inference engine",
                 "inference infrastructure", "vllm", "model serving", "tensorrt"], { query: ["inference"] }],
  ["mlops", ["mlops", "ml ops", "ml platform", "mlflow", "kubeflow", "sagemaker", "vertex ai"]],
  ["computer-vision", ["computer vision", "image recognition", "opencv", "vision artificial"]],
  ["nlp", ["nlp", "natural language processing", "procesamiento de lenguaje natural"]],
  ["recommender-systems", ["recommender systems", "recommendation systems", "recommender system", "recommendation engine", "personalization"]],
  ["statistics", ["statistics", "statistical", "estadistica", "a b testing", "experimentation", "causal inference", "econometrics"]],
  // "robot" only as a query word: descriptions say "not a robot" in their captcha notes.
  ["robotics", ["robotics", "robotica", "ros", "autonomous driving", "slam"], { query: ["robot"] }],
  // Security and compliance
  ["cybersecurity", ["cybersecurity", "cyber security", "ciberseguridad", "information security", "infosec",
                     "seguridad de la informacion", "security engineering", "application security", "appsec",
                     "cloud security", "devsecops", "threat detection", "vulnerability management"],
   { query: ["security", "seguridad", "cyber"] }],
  ["pentesting", ["penetration testing", "pentesting", "pentest", "red team", "ethical hacking", "bug bounty"]],
  ["soc", ["siem", "soar", "incident response", "security operations center", "soc analyst", "threat hunting"]],
  ["iam", ["identity and access management", "iam", "okta", "sso", "zero trust"]],
  ["grc", ["grc", "governance risk and compliance", "governance risk compliance", "risk management", "gestion de riesgos",
           "internal audit", "auditoria interna", "it audit"]],
  ["compliance", ["regulatory compliance", "compliance officer", "compliance analyst", "compliance manager",
                  "compliance program", "compliance framework", "compliance frameworks", "cumplimiento normativo",
                  "aml", "kyc", "anti money laundering", "regulatory reporting"], { query: ["compliance", "regulatory"] }],
  ["iso-27001", ["iso 27001", "iso27001", "27001", "ens", "esquema nacional de seguridad", "nist", "nis2", "dora"]],
  ["soc2", ["soc 2", "soc2", "pci dss", "pci"]],
  // Not bare "privacy" or "data protection": nearly every posting ends with a privacy notice.
  ["privacy", ["privacy engineering", "privacy program", "privacy counsel", "privacy compliance", "privacy by design",
               "data protection officer", "dpo", "lopd", "lopdgdd", "privacy regulations", "privacy laws"],
   { query: ["privacy", "data protection", "proteccion de datos", "gdpr", "rgpd"] }],
  // Industries
  ["fintech", ["fintech", "financial services", "banking", "neobank", "lending", "wealth management", "banca", "capital markets"]],
  ["payments", ["payments", "payment processing", "payment methods", "checkout", "acquiring", "card issuing", "psd2",
                "medios de pago", "pasarela de pago"], { query: ["payment", "pagos"] }],
  ["crypto", ["crypto", "cryptocurrency", "cryptocurrencies", "blockchain", "web3", "defi", "bitcoin", "ethereum"]],
  // Health insurance is a benefit almost everywhere: only the industry counts.
  ["insurtech", ["insurtech", "insurance company", "insurance industry", "insurance sector", "insurance products",
                 "insurance carriers", "insurance platform", "reinsurance", "aseguradora", "sector asegurador",
                 "underwriting", "claims management"], { query: ["insurance", "seguros"] }],
  ["healthtech", ["healthtech", "health tech", "digital health", "medtech", "medical devices", "healthcare industry",
                  "healthcare technology", "healthcare providers", "healthcare sector", "patients", "clinicians",
                  "salud digital", "sector sanitario", "pacientes"], { query: ["healthcare", "health", "salud", "sanidad"] }],
  ["biotech", ["biotech", "life sciences", "pharma", "pharmaceutical", "drug discovery", "bioinformatics", "genomics"]],
  ["edtech", ["edtech", "education technology", "e learning", "elearning", "online learning"]],
  ["ecommerce", ["ecommerce", "e commerce", "marketplace", "retail", "comercio electronico"]],
  // "Willing to travel" and travel benefits are not the industry.
  ["travel", ["travel industry", "travel tech", "traveltech", "travel technology", "online travel", "tourism", "turismo",
              "hospitality industry", "airlines", "travellers", "travelers", "sector turistico"],
   { query: ["travel", "viajes", "hospitality", "hotels"] }],
  ["mobility", ["mobility services", "mobility platform", "urban mobility", "mobility solutions", "ride hailing",
                "micromobility", "movilidad urbana", "electric vehicles", "ev charging", "car sharing", "carsharing"],
   { query: ["mobility", "movilidad"] }],
  ["logistics", ["logistics", "logistica", "supply chain", "shipping industry", "freight", "maritime", "warehouse management",
                 "last mile", "fleet management", "transportation management", "cadena de suministro"],
   { query: ["shipping", "transport", "transporte"] }],
  ["gaming", ["gaming", "video games", "videogames", "videojuegos", "game development", "unity3d", "unity engine",
              "unreal engine", "igaming", "betting"], { query: ["games", "unity"] }],
  ["adtech", ["adtech", "programmatic", "advertising technology", "ad tech", "martech"]],
  ["energy", ["renewable energy", "renewables", "energias renovables", "energy transition", "solar energy", "wind energy", "utilities", "smart grid", "energy sector"]],
  // Not bare "sustainability": "technical sustainability", "long-term sustainability".
  ["sustainability", ["environmental sustainability", "sustainability reporting", "sustainability strategy", "csrd",
                      "sostenibilidad ambiental", "esg", "climate tech", "climate change", "decarbonization",
                      "decarbonisation", "net zero", "carbon emissions", "carbon accounting", "carbon footprint",
                      "circular economy"], { query: ["sustainability", "sostenibilidad", "climate", "carbon"] }],
  ["proptech", ["proptech", "real estate", "inmobiliaria"]],
  ["legaltech", ["legaltech", "legal tech"]],
  ["telecom", ["telecom", "telecommunications", "telecomunicaciones", "telco", "5g"]],
  ["automotive", ["automotive", "automocion", "vehicles", "autonomous vehicles"]],
  ["aerospace", ["aerospace", "aeroespacial", "aviation", "space industry", "satellites", "satellite", "defence industry",
                 "defense industry", "defence sector", "defense sector"], { query: ["defence", "defense", "defensa", "space"] }],
  ["media", ["media company", "media industry", "streaming platform", "video streaming", "music industry",
             "entertainment industry", "publishing", "newsroom", "broadcasting", "broadcast"],
   { query: ["media", "streaming", "music", "entertainment"] }],
  ["saas", ["saas", "b2b saas"]],
  ["govtech", ["govtech", "public sector", "sector publico", "administracion publica"]],
  // Business tools and practices
  ["crm", ["crm", "hubspot", "pipedrive"]],
  ["seo", ["seo", "sem", "google ads", "ppc", "paid media", "performance marketing", "paid social"]],
  ["product-analytics", ["amplitude", "mixpanel", "google analytics", "ga4", "product analytics", "posthog"]],
  ["fp-a", ["fp a", "financial planning", "ifrs", "us gaap", "consolidation", "treasury"]],
  ["agile", ["scrum", "kanban", "agile"]],
  ["ux-research", ["user research", "usability testing", "ux research", "investigacion de usuarios"]],
  // Spoken languages asked for
  ["english", ["english", "ingles"]],
  ["spanish", ["spanish", "castellano", "espanol"]],
  ["catalan", ["catalan", "catala"]],
  ["french", ["french", "frances"]],
  ["german", ["german", "aleman"]],
  ["italian", ["italian", "italiano"]],
  ["portuguese", ["portuguese", "portugues"]],
  ["dutch", ["dutch", "neerlandes"]],
];

const formsOf = ([, forms, x]) => [...forms, ...(x?.query ?? [])];
const MAX_FORM_WORDS = Math.max(...KEYWORDS.flatMap((k) => formsOf(k).map((f) => f.split(" ").length)));
const ORDER_OF = new Map(KEYWORDS.map(([id], i) => [id, i]));
// A description form, and its plural, to the id it names.
const FORM_ID = new Map(KEYWORDS.flatMap(([id, forms]) => forms.flatMap((f) => [[f, id], [`${f}s`, id], [`${f}es`, id]])));
// A query word or phrase to the id it names: the forms and the looser query forms.
export const QUERY_KEYWORD = new Map(KEYWORDS.flatMap((k) => formsOf(k).flatMap((f) => [[f, k[0]], [`${f}s`, k[0]]])));
// Every way a keyword is written: what a query term naming it may also match in a title.
export const KEYWORD_FORMS = new Map(KEYWORDS.map((k) => [k[0], formsOf(k)]));
export const KEYWORD_WORDS = MAX_FORM_WORDS;

// The keyword ids a title and a description name, in KEYWORDS order.
export function keywordsOf(title, description = "") {
  const found = new Set();
  for (const text of [title, description]) {
    const tokens = words(text).split(" ").filter(Boolean);
    for (let i = 0; i < tokens.length; i++) {
      let phrase = "";
      for (let n = 0; n < MAX_FORM_WORDS && i + n < tokens.length; n++) {
        phrase = n ? `${phrase} ${tokens[i + n]}` : tokens[i];
        const id = FORM_ID.get(phrase);
        if (id) found.add(id);
      }
    }
    const cased = String(text ?? "").normalize("NFKD").replace(/[^\x00-\x7f]/g, "");
    for (const [id, , x] of KEYWORDS) if (x?.cased && !found.has(id) && x.cased.test(cased)) found.add(id);
  }
  return [...found].sort((a, b) => ORDER_OF.get(a) - ORDER_OF.get(b));
}

// Everything above for one posting, as jobs.mjs stores it. The description is
// read and left behind.
export function classify(job, description, known) {
  return { roles: titleRoles(job.title, known), seniority: seniorityOf(job.title),
           years: yearsAsked(description), regions: regionsOf(job.location),
           keywords: keywordsOf(job.title, description) };
}

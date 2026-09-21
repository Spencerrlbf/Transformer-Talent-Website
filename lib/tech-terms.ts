// Technologies a scorecard row can name, with the spellings people use for
// them. Used for one thing: a row that names a technology cannot read "yes"
// unless that technology (or another the row itself accepts) is actually
// named in the person's material. A judge that reasons "works at an agents
// company, so TypeScript" is caught here, in code, whatever the model says.
//
// Each entry is one technology: the first spelling is the display name.

const TECH: string[][] = [
  // languages
  ["TypeScript"], ["JavaScript"], ["Python"], ["Go", "Golang"], ["Java"], ["Kotlin"], ["Swift"], ["Rust"],
  ["C++"], ["C#"], ["Ruby"], ["PHP"], ["Scala"], ["Elixir"], ["Clojure"], ["Haskell"], ["OCaml"], ["Objective-C"], ["SQL"],
  // web and backend frameworks, runtimes
  ["Node.js", "NodeJS", "Node"], ["Deno"], ["Bun"], ["React", "React.js", "ReactJS"], ["React Native"], ["Next.js", "NextJS"],
  ["Vue", "Vue.js"], ["Angular"], ["Svelte"], ["Express", "Express.js"], ["NestJS", "Nest.js"], ["Django"], ["Flask"],
  ["FastAPI"], ["Rails", "Ruby on Rails"], ["Spring", "Spring Boot"], ["Laravel"], [".NET", "ASP.NET"], ["GraphQL"], ["gRPC"], ["tRPC"],
  // data
  ["PostgreSQL", "Postgres"], ["MySQL"], ["MongoDB", "Mongo"], ["Redis"], ["Kafka"], ["RabbitMQ"], ["SQS"], ["Snowflake"],
  ["BigQuery"], ["Redshift"], ["Spark", "PySpark"], ["Airflow"], ["dbt"], ["Elasticsearch", "OpenSearch"], ["DynamoDB"],
  ["Cassandra"], ["ClickHouse"], ["pgvector"], ["Pinecone"], ["Weaviate"], ["Qdrant"], ["Milvus"], ["FAISS"], ["Databricks"],
  // infrastructure
  ["AWS", "Amazon Web Services"], ["GCP", "Google Cloud"], ["Azure"], ["Kubernetes", "K8s"], ["Docker"], ["Terraform"],
  ["Temporal"], ["Prefect"], ["Pulumi"], ["Ansible"], ["Datadog"], ["Prometheus"], ["Grafana"], ["OpenTelemetry"],
  // ML and agents
  ["PyTorch"], ["TensorFlow"], ["JAX"], ["CUDA"], ["LangChain"], ["LangGraph"], ["LlamaIndex"], ["scikit-learn", "sklearn"],
  ["Hugging Face", "HuggingFace"], ["Ray"], ["MLflow"],
  // automation and mobile
  ["Playwright"], ["Puppeteer"], ["Selenium"], ["Cypress"], ["iOS"], ["Android"], ["Flutter"],
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Names that are also ordinary English words must match their own
// capitalisation ("Go", never "go beyond"; "Spring", never "spring 2024").
// Everything else is matched whatever its case: people write aws, JAVA, k8s.
const ALSO_A_WORD = new Set(["Go", "Ray", "Bun", "Swift", "Rust", "Spring", "Express", "Spark", "Flask", "Rails", "Cypress", "Node", "Vue", "React", "Angular", "Svelte", "Temporal", "Prefect", "Deno", "Java"]);

/** One spelling in a text, on token boundaries. */
function mentions(text: string, name: string): boolean {
  // "Go-to-market" is not the language.
  if (name === "Go") return /(^|[^A-Za-z0-9+#])Go(?![- ]to[- ]market)(?=$|[^A-Za-z0-9+#])/.test(text);
  if (name === "Java") return /(^|[^A-Za-z0-9+#])(Java|JAVA|java)(?=$|[^A-Za-z0-9+#])/.test(text);
  const strict = ALSO_A_WORD.has(name);
  const re = new RegExp(`(^|[^A-Za-z0-9+#])${escapeRe(strict ? name : name.toLowerCase())}(?=$|[^A-Za-z0-9+#])`, strict ? "" : "i");
  return re.test(strict ? text : text.toLowerCase());
}

/** The technologies a piece of text names, each as its list of spellings. */
export function technologiesNamed(text: string): string[][] {
  return TECH.filter((group) => group.some((name) => mentions(text, name)));
}

/** True when the material names at least one of the technologies. */
export function namesAny(material: string, technologies: string[][]): boolean {
  return technologies.some((group) => group.some((name) => mentions(material, name)));
}

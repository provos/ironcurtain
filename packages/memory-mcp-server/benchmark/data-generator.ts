/**
 * Test data generator — produces realistic memory corpora across categories
 * with known ground truth (which queries should retrieve which memories).
 *
 * Generates 500+ diverse test memories covering:
 *   - User preferences (UI, coding style, communication)
 *   - Project facts (deadlines, team members, tech stack)
 *   - Decisions (architectural choices, tool selections)
 *   - Observations (bugs found, patterns noticed)
 *   - Contradictions (facts that change over time)
 *   - Distractors (memories that should NOT match certain queries)
 */

import type { TestScenario, TestMemory } from './types.js';

// ---------------------------------------------------------------------------
// Category 1: Basic Recall Accuracy
// ---------------------------------------------------------------------------

export function basicRecallScenarios(): TestScenario[] {
  return [
    {
      id: 'basic-exact-keyword',
      name: 'Exact keyword recall',
      category: 'basic-recall',
      description: 'Store N facts, query for specific ones by keyword',
      memories: [
        { content: 'User prefers dark mode in all IDEs', tags: ['preference'] },
        { content: 'The project deadline is March 15, 2026', tags: ['project'] },
        { content: 'Alice is the tech lead on the payments team', tags: ['team'] },
        { content: 'We use PostgreSQL 16 as the primary database', tags: ['tech-stack'] },
        { content: 'The CI pipeline takes about 12 minutes to complete', tags: ['infrastructure'] },
        { content: 'Bob handles the DevOps and Kubernetes clusters', tags: ['team'] },
        { content: 'The API rate limit is 1000 requests per minute', tags: ['infrastructure'] },
        { content: 'User is allergic to peanuts', tags: ['personal'] },
        { content: 'The staging environment URL is staging.example.com', tags: ['infrastructure'] },
        { content: 'We adopted TypeScript strict mode in January 2026', tags: ['tech-stack', 'decision'] },
      ],
      queries: [
        {
          query: { query: 'What database do we use?' },
          expectation: { mustInclude: ['PostgreSQL'] },
        },
        {
          query: { query: 'Who is the tech lead?' },
          expectation: { mustInclude: ['Alice', 'payments'] },
        },
        {
          query: { query: 'What is the project deadline?' },
          expectation: { mustInclude: ['March 15'] },
        },
        {
          query: { query: 'API rate limit' },
          expectation: { mustInclude: ['1000 requests'] },
        },
      ],
    },
    {
      id: 'basic-tag-filter',
      name: 'Tag-filtered recall',
      category: 'basic-recall',
      description: 'Recall memories filtered by tag',
      memories: [
        { content: 'React 19 is used for the frontend', tags: ['tech-stack', 'frontend'] },
        { content: 'Express.js handles the API layer', tags: ['tech-stack', 'backend'] },
        { content: 'The team meets every Monday at 10am', tags: ['process'] },
        { content: 'Tailwind CSS is the styling framework', tags: ['tech-stack', 'frontend'] },
        { content: 'Jest is used for unit testing', tags: ['tech-stack', 'testing'] },
        { content: 'Code reviews require 2 approvals', tags: ['process'] },
      ],
      queries: [
        {
          query: { query: 'frontend technologies', tags: ['frontend'] },
          expectation: { mustInclude: ['React', 'Tailwind'] },
        },
        {
          query: { query: 'team processes', tags: ['process'] },
          expectation: { mustInclude: ['Monday', 'reviews'] },
        },
      ],
    },
    {
      id: 'basic-importance-ranking',
      name: 'Importance-based ranking',
      category: 'basic-recall',
      description: 'Higher importance memories should be preferred',
      memories: [
        { content: 'The office wifi password is sunshine42', importance: 0.2, tags: ['trivial'] },
        { content: 'Never deploy on Fridays — policy after the 2025 incident', importance: 0.95, tags: ['policy'] },
        { content: 'Lunch is usually at noon', importance: 0.1, tags: ['trivial'] },
        { content: 'All secrets must be rotated every 90 days', importance: 0.9, tags: ['security', 'policy'] },
        { content: 'The preferred coffee is a flat white', importance: 0.15, tags: ['trivial'] },
      ],
      queries: [
        {
          query: { query: 'important policies and rules', tokenBudget: 200 },
          expectation: {
            mustInclude: ['deploy on Fridays', 'secrets must be rotated'],
            mustExclude: ['wifi password', 'coffee'],
          },
        },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// Category 2: Semantic Search Quality
// ---------------------------------------------------------------------------

export function semanticSearchScenarios(): TestScenario[] {
  return [
    {
      id: 'semantic-paraphrase',
      name: 'Paraphrase retrieval',
      category: 'semantic-search',
      description: 'Query with different wording than stored memory — no keyword overlap',
      memories: [
        { content: 'User prefers dark mode in all IDEs and terminals' },
        { content: 'The authentication system uses JWT tokens with 1-hour expiry' },
        { content: 'We run end-to-end tests against a real database, not mocks' },
        { content: 'The mobile app is built with React Native for cross-platform support' },
        { content: 'Error monitoring is handled by Sentry with a 48-hour retention policy' },
        { content: 'The user is color blind (deuteranopia) and needs high contrast themes' },
        { content: 'SSH keys are required for repository access — no HTTPS auth allowed' },
        { content: 'The maximum file upload size is 50MB per request' },
      ],
      queries: [
        {
          query: { query: 'What are the UI appearance preferences?' },
          expectation: { mustInclude: ['dark mode'] },
        },
        {
          query: { query: 'How do we verify user identity?' },
          expectation: { mustInclude: ['JWT', 'authentication'] },
        },
        {
          query: { query: 'What is the testing strategy for integration tests?' },
          expectation: { mustInclude: ['real database'] },
        },
        {
          query: { query: 'How do we track application errors and crashes?' },
          expectation: { mustInclude: ['Sentry'] },
        },
        {
          query: { query: 'accessibility requirements for visual impairments' },
          expectation: { mustInclude: ['color blind', 'high contrast'] },
        },
        {
          query: { query: 'How do developers clone the repo?' },
          expectation: { mustInclude: ['SSH'] },
        },
      ],
    },
    {
      id: 'semantic-synonym',
      name: 'Synonym matching',
      category: 'semantic-search',
      description: 'Query uses synonyms of stored terms',
      memories: [
        { content: 'The application has severe latency issues under heavy load' },
        { content: 'Customer onboarding flow has a 40% drop-off rate at step 3' },
        { content: 'The infrastructure costs are projected to double by Q3' },
        { content: 'We migrated from monolith to microservices last quarter' },
        { content: 'The backup system runs every 6 hours with 30-day retention' },
      ],
      queries: [
        {
          query: { query: 'performance problems when many users are active' },
          expectation: { mustInclude: ['latency', 'heavy load'] },
        },
        {
          query: { query: 'user registration abandonment' },
          expectation: { mustInclude: ['onboarding', 'drop-off'] },
        },
        {
          query: { query: 'cloud spending forecast' },
          expectation: { mustInclude: ['infrastructure costs', 'double'] },
        },
        {
          query: { query: 'disaster recovery and data protection' },
          expectation: { mustInclude: ['backup', 'retention'] },
        },
      ],
    },
    {
      id: 'semantic-distractor',
      name: 'Distractor rejection',
      category: 'semantic-search',
      description: 'Server should return relevant memories and exclude distractors',
      memories: [
        { content: 'Python is used for the data pipeline ETL jobs' },
        { content: 'The Python snake at the office terrarium is named Monty' },
        { content: 'Java is used for the Android native modules' },
        { content: 'The team went to a Java coffee tasting event last Friday' },
        { content: 'Go is used for the high-performance message broker' },
        { content: 'The team will go to the offsite in Tahoe next month' },
      ],
      queries: [
        {
          query: { query: 'What programming languages does the team use?' },
          expectation: {
            mustInclude: ['Python', 'Java', 'Go'],
            mustExclude: ['terrarium', 'coffee tasting', 'Tahoe'],
          },
        },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// Category 3: Knowledge Updates (Contradiction Resolution)
// ---------------------------------------------------------------------------

export function knowledgeUpdateScenarios(): TestScenario[] {
  return [
    {
      id: 'update-deadline-change',
      name: 'Deadline update',
      category: 'knowledge-updates',
      description: 'Newer fact should supersede older one',
      memories: [
        { content: 'Project deadline is March 1, 2026', tags: ['project'] },
        { content: 'Project deadline has been moved to March 15, 2026', tags: ['project'], delayAfterMs: 50 },
      ],
      queries: [
        {
          query: { query: 'When is the project deadline?' },
          expectation: {
            mustInclude: ['March 15'],
            mustExclude: ['March 1'],
          },
        },
      ],
    },
    {
      id: 'update-tech-migration',
      name: 'Technology migration',
      category: 'knowledge-updates',
      description: 'Old tech should be superseded by new tech',
      memories: [
        { content: 'The frontend uses Angular 15 for the admin dashboard' },
        { content: 'We migrated the admin dashboard from Angular to React 19', delayAfterMs: 50 },
      ],
      queries: [
        {
          query: { query: 'What framework does the admin dashboard use?' },
          expectation: {
            mustInclude: ['React'],
          },
        },
      ],
    },
    {
      id: 'update-team-role-change',
      name: 'Role change',
      category: 'knowledge-updates',
      description: 'Person changed roles — latest role should be returned',
      memories: [
        { content: 'Sarah is the QA lead for the mobile team', tags: ['team'] },
        { content: 'Charlie is the project manager overseeing the backend rewrite', tags: ['team'] },
        { content: 'Sarah has been promoted to Engineering Manager, replacing Dave', tags: ['team'], delayAfterMs: 50 },
      ],
      queries: [
        {
          query: { query: "What is Sarah's current role?" },
          expectation: {
            mustInclude: ['Engineering Manager'],
          },
        },
      ],
    },
    {
      id: 'update-config-change',
      name: 'Configuration change',
      category: 'knowledge-updates',
      description: 'System config was updated',
      memories: [
        { content: 'The maximum request timeout is set to 30 seconds' },
        { content: 'Request timeout increased to 60 seconds after the microservices migration', delayAfterMs: 50 },
      ],
      queries: [
        {
          query: { query: 'What is the request timeout?' },
          expectation: {
            mustInclude: ['60 seconds'],
            mustExclude: ['30 seconds'],
          },
        },
      ],
    },
    {
      id: 'update-multiple-changes',
      name: 'Multiple sequential updates',
      category: 'knowledge-updates',
      description: 'Value changed multiple times — only latest should survive',
      memories: [
        { content: 'The CI build time is approximately 8 minutes' },
        { content: 'CI build time reduced to 5 minutes after build cache optimization', delayAfterMs: 30 },
        { content: 'CI build time now 3 minutes after switching to Turbopack', delayAfterMs: 30 },
      ],
      queries: [
        {
          query: { query: 'How long does the CI build take?' },
          expectation: {
            mustInclude: ['3 minutes'],
            mustExclude: ['8 minutes'],
          },
        },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// Category 4: Temporal Reasoning
// ---------------------------------------------------------------------------

export function temporalReasoningScenarios(): TestScenario[] {
  return [
    {
      id: 'temporal-recency',
      name: 'Recent memory preference',
      category: 'temporal-reasoning',
      description: 'More recent memories should rank higher when relevance is equal',
      memories: [
        { content: 'Sprint 10 goal: finish the search feature' },
        { content: 'Sprint 11 goal: optimize database queries', delayAfterMs: 50 },
        { content: 'Sprint 12 goal: implement user notifications', delayAfterMs: 50 },
        { content: 'Sprint 13 goal: add OAuth2 social login', delayAfterMs: 50 },
      ],
      queries: [
        {
          query: { query: 'What are we working on?', tokenBudget: 200 },
          expectation: {
            mustInclude: ['OAuth2', 'social login'],
          },
        },
      ],
    },
    {
      id: 'temporal-sequence',
      name: 'Event ordering',
      category: 'temporal-reasoning',
      description: 'When asking about sequence of events, temporal order matters',
      memories: [
        { content: 'Step 1: The database migration was started on Monday morning' },
        { content: 'Step 2: Migration hit an error on the users table at 2pm', delayAfterMs: 30 },
        { content: 'Step 3: Alice fixed the users table constraint issue by 4pm', delayAfterMs: 30 },
        { content: 'Step 4: Migration completed successfully Tuesday at 9am', delayAfterMs: 30 },
      ],
      queries: [
        {
          query: { query: 'What happened during the database migration?' },
          expectation: {
            mustInclude: ['migration', 'error', 'fixed', 'completed'],
          },
        },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// Category 5: Abstention
// ---------------------------------------------------------------------------

export function abstentionScenarios(): TestScenario[] {
  return [
    {
      id: 'abstention-unrelated',
      name: 'Unrelated query',
      category: 'abstention',
      description: 'Server should indicate no relevant memories when asked about unrelated topics',
      memories: [
        { content: 'The project uses React for the frontend' },
        { content: 'PostgreSQL is the primary database' },
        { content: 'Deployments happen through GitHub Actions' },
      ],
      queries: [
        {
          query: { query: 'What is the recipe for chocolate cake?' },
          expectation: { expectEmpty: true },
        },
        {
          query: { query: 'How tall is Mount Everest?' },
          expectation: { expectEmpty: true },
        },
      ],
    },
    {
      id: 'abstention-never-mentioned',
      name: 'Never-mentioned topics',
      category: 'abstention',
      description: 'Server should not hallucinate information about topics never stored',
      memories: [
        { content: 'The backend API is written in Node.js with Express' },
        { content: 'Redis is used for session caching with a 1-hour TTL' },
        { content: 'The team uses Slack for communication' },
        { content: 'All code must pass ESLint checks before merging' },
      ],
      queries: [
        {
          query: { query: 'What is our mobile app strategy?' },
          expectation: { expectEmpty: true },
        },
        {
          query: { query: 'Who is the CEO of the company?' },
          expectation: { expectEmpty: true },
        },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// Category 6: Token Budget Efficiency
// ---------------------------------------------------------------------------

export function tokenBudgetScenarios(): TestScenario[] {
  const manyMemories: TestMemory[] = [];
  for (let i = 0; i < 100; i++) {
    manyMemories.push({
      content: `Project note #${i + 1}: ${randomProjectFact(i)}`,
      importance: 0.3 + Math.random() * 0.5,
      tags: ['project-note'],
    });
  }

  return [
    {
      id: 'budget-small',
      name: 'Small token budget',
      category: 'token-budget',
      description: 'With a small budget, only the most relevant facts should be returned',
      memories: manyMemories,
      queries: [
        {
          query: { query: 'project status and key facts', tokenBudget: 100 },
          expectation: { minRelevant: 1 },
        },
        {
          query: { query: 'project status and key facts', tokenBudget: 500 },
          expectation: { minRelevant: 3 },
        },
        {
          query: { query: 'project status and key facts', tokenBudget: 2000 },
          expectation: { minRelevant: 5 },
        },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// Category 7: Deduplication Quality
// ---------------------------------------------------------------------------

export function deduplicationScenarios(): TestScenario[] {
  return [
    {
      id: 'dedup-exact',
      name: 'Exact duplicate detection',
      category: 'deduplication',
      description: 'Storing the same fact twice should not produce duplicates in recall',
      memories: [
        { content: 'The primary database is PostgreSQL 16' },
        { content: 'The primary database is PostgreSQL 16' },
        { content: 'The primary database is PostgreSQL 16' },
        { content: 'Redis is used for caching' },
      ],
      queries: [
        {
          query: { query: 'What databases do we use?', format: 'raw' },
          expectation: {
            mustInclude: ['PostgreSQL', 'Redis'],
          },
        },
      ],
    },
    {
      id: 'dedup-near-duplicate',
      name: 'Near-duplicate detection',
      category: 'deduplication',
      description: 'Slightly different phrasings of the same fact should be merged',
      memories: [
        { content: 'User prefers tabs over spaces for indentation' },
        { content: 'The user likes tabs instead of spaces' },
        { content: 'Indentation preference: tabs, not spaces' },
        { content: 'User prefers dark mode' },
        { content: 'The user likes dark themes' },
      ],
      queries: [
        {
          query: { query: 'What are the user preferences?', format: 'raw' },
          expectation: {
            mustInclude: ['tabs', 'dark'],
          },
        },
      ],
    },
    {
      id: 'dedup-distinct-preserved',
      name: 'Distinct facts preserved',
      category: 'deduplication',
      description: 'Similar-looking but distinct facts should NOT be merged',
      memories: [
        { content: 'Alice joined the team in January 2025' },
        { content: 'Bob joined the team in March 2025' },
        { content: 'Charlie joined the team in June 2025' },
      ],
      queries: [
        {
          query: { query: 'When did team members join?' },
          expectation: {
            mustInclude: ['Alice', 'Bob', 'Charlie'],
          },
        },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// Category 8: Scale Stress
// ---------------------------------------------------------------------------

export function scaleStressScenarios(scale: number): TestScenario[] {
  const memories: TestMemory[] = [];
  const categories = ['frontend', 'backend', 'devops', 'design', 'product'];

  for (let i = 0; i < scale; i++) {
    const cat = categories[i % categories.length];
    memories.push({
      content: `[${cat}] Observation #${i + 1}: ${randomObservation(i, cat)}`,
      tags: [cat],
      importance: 0.2 + Math.random() * 0.6,
    });
  }

  // Add a few "needle in haystack" memories with unique keywords
  memories.push({
    content: 'CRITICAL: The Zephyr API key expires on April 1, 2026 and must be rotated',
    tags: ['security'],
    importance: 0.95,
  });
  memories.push({
    content: 'The Tungsten microservice has a memory leak that crashes every 72 hours',
    tags: ['backend', 'bug'],
    importance: 0.9,
  });

  return [
    {
      id: `scale-${scale}`,
      name: `Scale test at ${scale} memories`,
      category: 'scale-stress',
      description: `Store ${scale} memories and measure retrieval quality and latency`,
      memories,
      queries: [
        {
          query: { query: 'Zephyr API key expiration' },
          expectation: { mustInclude: ['Zephyr', 'April 1'] },
        },
        {
          query: { query: 'services with memory leaks or crashes' },
          expectation: { mustInclude: ['Tungsten', 'memory leak'] },
        },
        {
          query: { query: 'frontend observations', tags: ['frontend'] },
          expectation: { minRelevant: 1 },
        },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// Category 9: Session Briefing (memory_context)
// ---------------------------------------------------------------------------

export function sessionBriefingScenarios(): TestScenario[] {
  return [
    {
      id: 'briefing-task-relevant',
      name: 'Task-relevant briefing',
      category: 'session-briefing',
      description: 'memory_context should return memories relevant to the given task',
      memories: [
        { content: 'The authentication service uses OAuth2 with PKCE flow', tags: ['auth'], importance: 0.8 },
        { content: 'User session tokens expire after 1 hour', tags: ['auth'], importance: 0.7 },
        { content: 'The Redis cache layer sits in front of the auth service', tags: ['auth', 'infrastructure'] },
        { content: 'The frontend uses Zustand for state management', tags: ['frontend'] },
        { content: 'GraphQL is used for the public API', tags: ['api'] },
        { content: 'The payment system integrates with Stripe', tags: ['payments'] },
        {
          content: 'All PII must be encrypted at rest per GDPR compliance',
          tags: ['security', 'compliance'],
          importance: 0.9,
        },
        { content: 'Database backups run every 6 hours to S3', tags: ['infrastructure'] },
      ],
      queries: [
        {
          // memory_context queries use a different code path — see runner
          query: { query: 'Debugging an authentication token expiry bug' },
          expectation: {
            mustInclude: ['OAuth2', 'session tokens', 'expire'],
          },
        },
        {
          query: { query: 'Adding a new payment provider' },
          expectation: {
            mustInclude: ['Stripe', 'payment'],
          },
        },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// Master generator
// ---------------------------------------------------------------------------

export interface GeneratorOptions {
  categories?: string[];
  scaleSize?: number;
}

export function generateAllScenarios(opts?: GeneratorOptions): TestScenario[] {
  const cats = new Set(opts?.categories ?? []);
  const includeAll = cats.size === 0;
  const scale = opts?.scaleSize ?? 1000;

  const scenarios: TestScenario[] = [];

  if (includeAll || cats.has('basic-recall')) scenarios.push(...basicRecallScenarios());
  if (includeAll || cats.has('semantic-search')) scenarios.push(...semanticSearchScenarios());
  if (includeAll || cats.has('knowledge-updates')) scenarios.push(...knowledgeUpdateScenarios());
  if (includeAll || cats.has('temporal-reasoning')) scenarios.push(...temporalReasoningScenarios());
  if (includeAll || cats.has('abstention')) scenarios.push(...abstentionScenarios());
  if (includeAll || cats.has('token-budget')) scenarios.push(...tokenBudgetScenarios());
  if (includeAll || cats.has('deduplication')) scenarios.push(...deduplicationScenarios());
  if (includeAll || cats.has('scale-stress')) scenarios.push(...scaleStressScenarios(scale));
  if (includeAll || cats.has('session-briefing')) scenarios.push(...sessionBriefingScenarios());

  return scenarios;
}

// ---------------------------------------------------------------------------
// Random content generators (deterministic per index)
// ---------------------------------------------------------------------------

const PROJECT_FACTS = [
  'The API response time SLA is under 200ms for p99',
  'We use feature flags via LaunchDarkly for gradual rollouts',
  'The logging pipeline sends to Elasticsearch via Fluentd',
  'Code coverage must stay above 80% for all new PRs',
  'The CDN is Cloudflare with 24-hour cache TTL for static assets',
  'Database connection pooling is set to max 20 connections per service',
  'The GraphQL schema is generated from TypeScript types',
  'Kubernetes pods have a 512MB memory limit and 0.5 CPU',
  'The message queue uses RabbitMQ with durable queues',
  'Sentry captures frontend errors with a 10% sample rate',
  'Playwright is used for end-to-end browser testing',
  'The design system uses Figma with weekly sync to code',
  'Authentication tokens use RS256 signing algorithm',
  'The CI/CD pipeline runs on GitHub Actions with self-hosted runners',
  'Database migrations use Prisma with a shadow database for validation',
  'The monorepo uses Turborepo for build orchestration',
  'API documentation is auto-generated with Swagger/OpenAPI 3.1',
  'The event bus uses Apache Kafka with 7-day retention',
  'Static analysis runs Semgrep rules for security checks',
  'The search feature is powered by Elasticsearch 8 with vector search',
];

function randomProjectFact(idx: number): string {
  return PROJECT_FACTS[idx % PROJECT_FACTS.length];
}

const OBSERVATIONS_BY_CATEGORY: Record<string, string[]> = {
  frontend: [
    'React re-renders are causing janky scrolling on the user list page',
    'The bundle size increased 15% after adding the charting library',
    'Lighthouse score dropped to 72 on mobile after the redesign',
    'The form validation library has inconsistent error messages',
    'Dark mode colors need adjustment for WCAG AA compliance',
  ],
  backend: [
    'The user service has N+1 query issues on the profile endpoint',
    'Connection pool exhaustion occurs under sustained 500 RPS',
    'The caching layer misses on about 30% of product queries',
    'Rate limiting is not applied consistently across all API versions',
    'The batch import endpoint times out for files over 10MB',
  ],
  devops: [
    'Kubernetes node auto-scaling takes too long during traffic spikes',
    'The Terraform state file is getting unwieldy at 50MB',
    'SSL certificate renewal automation failed last month',
    'Docker image sizes grew to 2GB after the Python dependency additions',
    'The monitoring dashboard has blind spots for async job failures',
  ],
  design: [
    'The navigation redesign increased task completion by 23%',
    'Users are confused by the dual-save pattern on the settings page',
    'The color palette needs updating for the rebrand in Q2',
    'Mobile touch targets are too small on the checkout flow',
    'The loading skeleton components are inconsistent across pages',
  ],
  product: [
    'Feature request for CSV export is the top-voted item',
    'Churn rate increased 5% after removing the free tier',
    'The onboarding wizard completion rate is 62%',
    'Enterprise customers want SSO with SAML support',
    'The notifications feature has a 15% engagement rate',
  ],
};

function randomObservation(idx: number, category: string): string {
  const pool = OBSERVATIONS_BY_CATEGORY[category] ?? OBSERVATIONS_BY_CATEGORY.frontend;
  return pool[idx % pool.length];
}

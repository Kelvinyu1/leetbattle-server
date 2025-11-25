const fetch = (...args) => import('node-fetch').then(m => m.default(...args));

// GraphQL endpoints
const LEETCODE_GRAPHQL = "https://leetcode.com/graphql";

/**
 * Helper: Run a GraphQL query against LeetCode
 */
async function lcQuery(query, variables = {}) {
  const res = await fetch(LEETCODE_GRAPHQL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables })
  });

  const json = await res.json();
  if (json.errors) {
    throw new Error(JSON.stringify(json.errors, null, 2));
  }
  return json.data;
}

/**
 * Step 1: Fetch all problem slugs
 */
async function fetchAllProblems() {
  const query = `
    query problemsetQuestionListV2($limit: Int, $skip: Int) {
      problemsetQuestionListV2: problemsetQuestionListV2(
        categorySlug: ""
        limit: $limit
        skip: $skip
      ) {
        questions {
          titleSlug
        }
      }
    }
  `;

  let skip = 0;
  const limit = 100;
  let slugs = [];

  while (true) {
    const data = await lcQuery(query, { limit, skip });
    const questions = data.problemsetQuestionListV2.questions;

    if (!questions || questions.length === 0) break;

    slugs.push(...questions.map(q => q.titleSlug));
    skip += limit;
  }

  return slugs;
}

/**
 * Step 2: Fetch full question data by slug
 */
async function fetchProblem(slug) {
  const query = `
    query questionData($titleSlug: String!) {
      question(titleSlug: $titleSlug) {
        title
        difficulty
        content
        codeSnippets {
          lang
          code
        }
      }
    }
  `;

  const data = await lcQuery(query, { titleSlug: slug });
  return data.question;
}

function stripHtml(html) {
  if (!html) return "";

  let text = html;

  // Convert <br> to newlines
  text = text.replace(/<br\s*\/?>/gi, "\n");

  // Block-level tags → newline
  text = text.replace(/<\/?(p|div|section|article|h[1-6]|li|ul|ol)[^>]*>/gi, "\n");

  // Remove scripts & styles
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");

  // Remove all other tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode HTML entities
  text = text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

  // Normalize newlines
  text = text.replace(/\r\n/g, "\n");

  // Collapse 3+ newlines → 2
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}


function decodeHTML(html) {
    if (!html) return "";
    var map = {"gt":">" /* , … */};
    return html.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z]+);?/gi, function($0, $1) {
        if ($1[0] === "#") {
            return String.fromCharCode($1[1].toLowerCase() === "x" ? parseInt($1.substr(2), 16)  : parseInt($1.substr(1), 10));
        } else {
            return map.hasOwnProperty($1) ? map[$1] : $0;
        }
    });
};

/**
 * Step 3: Transform into your desired format
 */
function convertProblem(slug, q) {
  return {
    slug,
    title: q.title,
    difficulty: q.difficulty,
    //statement: q.content, // WARNING: contains HTML from LeetCode
    statement: decodeHTML(stripHtml(q.content)),
    starter_code: {
      python:
        q.codeSnippets?.find?.(s => s.lang === "Python")?.code || ""
    },
    exportName: slug.replace(/-([a-z])/g, (_, c) => c.toUpperCase()),
    tests: [] // No official tests available → leave empty or custom
  };
}

/**
 * Main: fetch random problem & return JSON
 */
async function getRandomProblem() {
  const slugs = await fetchAllProblems();
  const slug = slugs[Math.floor(Math.random() * slugs.length)];

  const problem = await fetchProblem(slug);

  const formatted = convertProblem(slug, problem);
  return formatted;
}

module.exports = { getRandomProblem };

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
// async function fetchProblem(slug) {
//   const query = `
//     query questionData($titleSlug: String!) {
//       question(titleSlug: $titleSlug) {
//         title
//         difficulty
//         content
//         codeSnippets {
//           lang
//           code
//         }
//       }
//     }
//   `;

//   const data = await lcQuery(query, { titleSlug: slug });
//   return data.question;
// }
async function fetchProblem(slug) {
  const query = `
    query questionData($titleSlug: String!) {
      question(titleSlug: $titleSlug) {
        title
        difficulty
        content
        exampleTestcases
        jsonExampleTestcases
        sampleTestCase
        metaData
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

  // Block-level tags to newline
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
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");

  // Normalize newlines
  text = text.replace(/\r\n/g, "\n");

  // Collapse 3+ newlines into 1
  text = text.replace(/\n{3,}/g, "\n");

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
 *  Extract tests from LeetCode
 */
function extractTests(q) {
  // BEST CASE: jsonExampleTestcases exists
  if (q.jsonExampleTestcases) {
    try {
      const parsed = JSON.parse(q.jsonExampleTestcases);
      // Format into judge format
      return parsed.map(test => ({
        input: { args: Object.values(test.input) },
        output: test.output
      }));
    } catch (err) {
      console.error("Failed to parse jsonExampleTestcases:", err);
    }
  }

  // FALLBACK: Use exampleTestcases + metaData
  if (q.exampleTestcases && q.metaData) {
    try {
      const meta = JSON.parse(q.metaData);
      const paramCount = meta.params?.length || 0;

      const lines = q.exampleTestcases.trim().split("\n");
      if (lines.length >= paramCount) {
        const args = lines.slice(0, paramCount).map(s => {
          try { return JSON.parse(s); } catch { return s; }
        });
        return [{
          input: { args },
          output: null   // no official output provided
        }];
      }
    } catch (err) {
      console.error("Meta parsing error:", err);
    }
  }

  // If nothing found 
  return [];
}

/**
 * Robustly clean Python starter code:
 * - Removes class Solution wrapper (or any class wrapper)
 * - Converts tabs to spaces
 * - Removes common indentation inside the class block
 * - Removes 'self' from def parameter lists (handles annotations & defaults)
 */
function cleanPythonStarter(raw) {
  if (!raw || typeof raw !== "string") return "";

  // Normalize tabs -> 4 spaces
  let code = raw.replace(/\t/g, "    ");

  // Split into lines for processing
  const lines = code.split("\n");

  // Find class wrapper (common is "class Solution:")
  let classStartIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    // handle class Solution and other potential wrapper names safely
    if (/^class\s+\w+\s*[:\(]/.test(trimmed)) {
      // we consider this a wrapper only if following lines are indented
      classStartIndex = i;
      break;
    }
  }

  if (classStartIndex >= 0) {
    // Collect lines that belong to the class block (indented after classStartIndex)
    const classBlock = [];
    for (let i = classStartIndex + 1; i < lines.length; i++) {
      // stop if we hit another top-level class/def with no indent (def at top-level) OR blank line?
      // but safer: include lines that are indented (start with space)
      if (lines[i].match(/^\s+/)) {
        classBlock.push(lines[i]);
      } else {
        // stop when a non-indented line is seen (end of class block)
        break;
      }
    }

    if (classBlock.length > 0) {
      // compute minimum indent (number of leading spaces) across non-blank classBlock lines
      let minIndent = Infinity;
      for (const ln of classBlock) {
        if (/^\s*$/.test(ln)) continue;
        const m = ln.match(/^ +/);
        if (m) {
          minIndent = Math.min(minIndent, m[0].length);
        }
      }
      if (minIndent === Infinity) minIndent = 4; // fallback

      // extract cleaned lines: replace class block lines with unindented versions
      const before = lines.slice(0, classStartIndex);
      const afterStart = classStartIndex + 1 + classBlock.length;
      const after = lines.slice(afterStart);

      const unindented = classBlock.map(ln => ln.startsWith(" ".repeat(minIndent)) ? ln.slice(minIndent) : ln.replace(/^\s+/, ""));
      // merge: before + unindented + after
      const merged = [...before, ...unindented, ...after];
      code = merged.join("\n");
    } else {
      // class line found but no indented block — just remove the class line
      const merged = [...lines.slice(0, classStartIndex), ...lines.slice(classStartIndex + 1)];
      code = merged.join("\n");
    }
  } else {
    // No class wrapper found — keep original normalized code
    code = lines.join("\n");
  }

  // Now remove 'self' from def parameter lists robustly
  // handle patterns like:
  // def name(self, a, b=1):  -> def name(a, b=1):
  // def name(self):          -> def name():
  // def name(self , a:int):  -> def name(a:int):
  // def name(self, *args, **kwargs):
  code = code.replace(/def\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(\s*self\s*(,)?\s*/g, "def $1(");
  // Also handle cases where self is not the first param (rare), remove occurrences of "self," inside parentheses
  code = code.replace(/\(\s*([^)]*?)\bself\s*,\s*/g, "($1");
  // and if parameter list ends with 'self' (no other params)
  code = code.replace(/\(\s*self\s*\)/g, "()");

  // Remove any leading indentation from top-level (in case whole snippet was indented)
  // Determine minimal leading indent across non-empty lines
  const finalLines = code.split("\n");
  let minLeading = Infinity;
  for (const ln of finalLines) {
    if (/^\s*$/.test(ln)) continue;
    const m = ln.match(/^ +/);
    if (m) minLeading = Math.min(minLeading, m[0].length);
    else {
      minLeading = 0;
      break;
    }
  }
  if (minLeading > 0 && minLeading < Infinity) {
    for (let i = 0; i < finalLines.length; i++) {
      if (finalLines[i].startsWith(" ".repeat(minLeading))) finalLines[i] = finalLines[i].slice(minLeading);
    }
    code = finalLines.join("\n");
  } else {
    code = finalLines.join("\n");
  }

  // Trim leading/trailing blank lines and trailing spaces
  code = code.replace(/^\s*\n/, "");
  code = code.replace(/\n\s*$/, "");
  code = code.replace(/[ \t]+$/gm, "");

  return code.trim();
}

/**
 * Step 3: Transform into your desired format
 */
function convertProblem(slug, q) {
  const rawPython = q.codeSnippets?.find?.(s => s.lang === "Python")?.code || "";
  const cleanedPython = cleanPythonStarter(rawPython);
  return {
    slug,
    title: q.title,
    difficulty: q.difficulty,
    statement: decodeHTML(stripHtml(q.content)),
    starter_code: {
      // python:
      //   q.codeSnippets?.find?.(s => s.lang === "Python")?.code || ""
      python: cleanedPython
    },
    exportName: slug.replace(/-([a-z])/g, (_, c) => c.toUpperCase()),

    // tests: [
    //   {
    //     input: { args: [] },
    //     output: null
    //   }
    // ]
    tests: extractTests(q)
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

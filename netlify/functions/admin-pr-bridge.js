/* netlify/functions/admin-pr-bridge.js /
exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: cors, body: '' };
  }
  try {
    const {
GITHUB_TOKEN,
      GITHUB_REPO,
      GITHUB_BOT_NAME,
      GITHUB_BOT_EMAIL,
      GITHUB_DEFAULT_BRANCH,
      CRM_ADMIN_TOKEN
    } = process.env;

    if (!GITHUB_TOKEN  !GITHUB_REPO 
 !CRM_ADMIN_TOKEN) {
      return { statusCode: 500, headers: cors, body: 'Missing env vars' };
    }

    const auth = event.headers.authorization || '';
    const bearer = auth.replace(/^Bearer\s+/i, '');
    if (bearer !== CRM_ADMIN_TOKEN) {
      return { statusCode: 401, headers: cors, body: 'Unauthorized' };
    }
const { branch, title, message, files } = JSON.parse(event.body  '{}');
    if (!branch 
 !title  !files?.length) {
      return { statusCode: 400, headers: cors, body: 'branch, title, files[] required' };
    }

    const gh = (path, init = {}) =>
      fetch(https://api.github.com/repos/${GITHUB_REPO}${path}, {
        ...init,
        headers: {
          'Authorization': Bearer ${GITHUB_TOKEN},
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(init.headers 
 {})
        }
      });

    // 1) Figure out base (default) branch
let baseBranch = GITHUB_DEFAULT_BRANCH || 'main';
    if (!GITHUB_DEFAULT_BRANCH) {
      const repoRes = await gh('');
      const repoJson = await repoRes.json();
      if (repoRes.ok && repoJson.default_branch) baseBranch = repoJson.default_branch;
    }

    // 2) Get latest commit + tree on base
    const refRes = await gh(/git/ref/heads/${encodeURIComponent(baseBranch)});
    if (!refRes.ok) return { statusCode: 400, headers: cors, body: 'Base branch not found' };
    const refJson = await refRes.json();
    const baseCommitSha = refJson.object.sha;

    const baseCommitRes = await gh(/git/commits/${baseCommitSha});
    const baseCommit = await baseCommitRes.json();
    const baseTreeSha = baseCommit.tree.sha;
// 3) Create blobs for files
    const blobShas = [];
    for (const f of files) {
      const blobRes = await gh('/git/blobs', {
        method: 'POST',
        body: JSON.stringify({ content: f.content, encoding: 'utf-8' })
      });
      if (!blobRes.ok) return { statusCode: 400, headers: cors, body: 'Blob create failed' };
      const blob = await blobRes.json();
      blobShas.push({ path: f.path, sha: blob.sha });
    }

    // 4) Create new tree
    const treeRes = await gh('/git/trees', {
      method: 'POST',
      body: JSON.stringify({
        base_tree: baseTreeSha,
tree: blobShas.map(b => ({ path: b.path, mode: '100644', type: 'blob', sha: b.sha }))
      })
    });
    if (!treeRes.ok) return { statusCode: 400, headers: cors, body: 'Tree create failed' };
    const tree = await treeRes.json();

    // 5) Create commit
    const commitRes = await gh('/git/commits', {
      method: 'POST',
      body: JSON.stringify({
        message: message || title,
        tree: tree.sha,
        parents: [baseCommitSha],
        author: GITHUB_BOT_NAME && GITHUB_BOT_EMAIL ? { name: GITHUB_BOT_NAME, email: GITHUB_BOT_EMAIL } : undefined
      })
    });
    if (!commitRes.ok) return { statusCode: 400, headers: cors, body: 'Commit failed' };
const newCommit = await commitRes.json();

    // 6) Ensure branch exists, then move it to new commit
    const newRef = refs/heads/${branch};
    let haveBranch = true;
    const checkBranch = await gh(/git/ref/heads/${encodeURIComponent(branch)});
    if (checkBranch.status === 404) haveBranch = false;

    if (!haveBranch) {
      const createRef = await gh('/git/refs', {
        method: 'POST',
        body: JSON.stringify({ ref: newRef, sha: baseCommitSha })
      });
      if (!createRef.ok) return { statusCode: 400, headers: cors, body: 'Create branch failed' };
    }

    const moveRef = await gh(/git/refs/heads/${encodeURIComponent(branch)}, {
method: 'PATCH',
      body: JSON.stringify({ sha: newCommit.sha, force: true })
    });
    if (!moveRef.ok) return { statusCode: 400, headers: cors, body: 'Update branch failed' };

    // 7) Open PR
    const prRes = await gh('/pulls', {
      method: 'POST',
      body: JSON.stringify({ title, head: branch, base: baseBranch, body: message || '' })
    });
    if (!prRes.ok) return { statusCode: 400, headers: cors, body: 'PR create failed' };
    const pr = await prRes.json();

    return { statusCode: 200, headers: cors, body: JSON.stringify({ url: pr.html_url }) };
  } catch (e) {
    return { statusCode: 500, headers: { 'Content-Type': 'text/plain' }, body: String(e) };
  }
};

import { ApiClient } from "./api.js";
import { createContent } from "./text.js";
import { runLinguist } from "./linguist.js";

const { GH_TOKEN, GIST_ID, USERNAME, DAYS} = process.env;

/**
 * 更新README中的语言统计块
 * 
 * @param {ApiClient} api - GitHub API客户端
 * @param {string} repoName - 仓库名称，格式为 owner/repo
 * @param {string} path - README文件路径
 * @param {string} content - 要插入的内容
 * @returns {Promise<boolean>} - 是否成功更新
 */
async function updateReadme(api, repoName, path = "README.md", content) {
  try {
    console.log(`Updating README in ${repoName}...`);
    
    // 获取文件内容和SHA
    const fileData = await api.fetch(`/repos/${repoName}/contents/${path}`);
    const originalContent = Buffer.from(fileData.content, 'base64').toString();
    const sha = fileData.sha;
    
    // 查找标记块
    const startMarker = `<!-- lang-box start -->`;
    const endMarker = `<!-- lang-box end -->`;
    
    const startIndex = originalContent.indexOf(startMarker);
    const endIndex = originalContent.indexOf(endMarker);
    
    if (startIndex === -1 || endIndex === -1 || startIndex >= endIndex) {
      console.log(`无法在README中找到有效的${marker}标记块`);
      return false;
    }
    
    // 替换内容
    const newContent = 
      originalContent.substring(0, startIndex + startMarker.length) + 
      "\n```\n" + content + "\n```\n" + 
      originalContent.substring(endIndex);
    
    // 提交更新
    await api.fetch(`/repos/${repoName}/contents/${path}`, "PUT", {
      message: `更新语言使用统计 [自动]`,
      content: Buffer.from(newContent).toString('base64'),
      sha
    });
    
    console.log(`README更新成功！`);
    return true;
  } catch (e) {
    console.error(`README更新失败: ${e.message}`);
    return false;
  }
}

(async () => {
  try {
    if (!GH_TOKEN) {
      throw new Error("GH_TOKEN is not provided.");
    }
    if (!GIST_ID) {
      throw new Error("GIST_ID is not provided.");
    }
    if (!USERNAME) {
      throw new Error("USERNAME is not provided.");
    }

    const api = new ApiClient(GH_TOKEN);
    const username = USERNAME;
    const days = Math.max(1, Math.min(30, Number(DAYS || 14)));

    console.log(`username is ${username}.`);
    console.log(`\n`);

    // https://docs.github.com/en/rest/reference/activity
    // GitHub API supports 300 events at max and events older than 90 days will not be fetched.
    const maxEvents = 300;
    const perPage = 100;
    const pages = Math.ceil(maxEvents / perPage);
    const fromDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const commits = [];
    try {
      for (let page = 0; page < pages; page++) {
        // https://docs.github.com/en/developers/webhooks-and-events/github-event-types#pushevent
        const pushEvents = (
          await api.fetch(
            `/users/${username}/events?per_page=${perPage}&page=${page}`
          )
        ).filter(
          ({ type, actor }) => type === "PushEvent" && actor.login === username
        );

        const recentPushEvents = pushEvents.filter(
          ({ created_at }) => new Date(created_at) > fromDate
        );
        const isEnd = recentPushEvents.length < pushEvents.length;
        console.log(`${recentPushEvents.length} events fetched.`);

        commits.push(
          ...(
            await Promise.allSettled(
              recentPushEvents.flatMap(({ repo, payload }) =>
                payload.commits
                  // Ignore duplicated commits
                  .filter((c) => c.distinct === true)
                  .map((c) => api.fetch(`/repos/${repo.name}/commits/${c.sha}`))
              )
            )
          )
            .filter(({ status }) => status === "fulfilled")
            .map(({ value }) => value)
        );

        if (isEnd) {
          break;
        }
      }
    } catch (e) {
      console.log("no more page to load");
    }

    console.log(`${commits.length} commits fetched.`);
    console.log(`\n`);

    // https://docs.github.com/en/rest/reference/repos#compare-two-commits
    const files = commits
      // Ignore merge commits
      .filter((c) => c.parents.length <= 1)
      .flatMap((c) =>
        c.files.map(
          ({
            filename,
            additions,
            deletions,
            changes,
            status, // added, removed, modified, renamed
            patch,
          }) => ({
            path: filename,
            additions,
            deletions,
            changes,
            status,
            patch,
          })
        )
      );

    const langs = await runLinguist(files);
    console.log(`\n`);
    langs.forEach((l) =>
      console.log(
        `${l.name}: ${l.count} files, ${l.additions + l.deletions} changes`
      )
    );

    const content = createContent(langs);
    console.log(`\n`);
    console.log(content);
    console.log(`\n`);

    // 更新Gist
    const gist = await api.fetch(`/gists/${GIST_ID}`);
    const filename = Object.keys(gist.files)[0];
    await api.fetch(`/gists/${GIST_ID}`, "PATCH", {
      files: {
        [filename]: {
          filename: `💻 Recent coding in languages`,
          content,
        },
      },
    });
    console.log(`更新Gist成功.`);

    // 更新README（如果配置了）
    if (README_REPO) {
      const readmePath = README_PATH || "README.md";
      const readmeMarker = README_MARKER || "LANGUAGE_STATS";
      const repoName = README_REPO.includes("/") ? README_REPO : `${USERNAME}/${README_REPO}`;
      
      await updateReadme(api, repoName, readmePath, readmeMarker, content);
    }
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  }
})();

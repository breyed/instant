// @ts-check

import { mkdir, writeFile, readFile, stat } from "fs/promises";
import { join } from "path";
import { createServer } from "http";

import envPaths from "env-paths";
import open from "open";
import chalk from "chalk";
import { program } from "commander";
import { input, confirm } from "@inquirer/prompts";
import { loadConfig } from "unconfig";
import { randomUUID } from "crypto";
import { packageDirectory } from "pkg-dir";

// config

const dev = Boolean(process.env.DEV);
const verbose = Boolean(process.env.VERBOSE);

const instantDashOrigin = dev
  ? "http://localhost:3000"
  : "https://instantdb.com";
const instantBackendOrigin = dev
  ? "http://localhost:8888"
  : "https://api.instantdb.com";

const authUrl = instantDashOrigin + "/dash?_cli=1";
const magicLocalhostPort = 65432;

// cli

program
  .name("instant-cli")
  .description(
    `
${chalk.magenta(`Instant CLI`)}
Docs: ${chalk.underline(`https://www.instantdb.com/docs/cli`)}
Dash: ${chalk.underline(`https://www.instantdb.com/dash`)}
Discord: ${chalk.underline(`https://discord.com/invite/VU53p7uQcE`)}`.trim(),
  )
  .option("-t --token <TOKEN>", "auth token override")
  .option("-y", "skip confirmation prompt");

program
  .command("login")
  .description("Authenticates with Instant")
  .action(login);

program
  .command("init")
  .description("Creates a new app with configuration files")
  .action(init);

program
  .command("push-schema")
  .description("Pushes local instant.schema definition to production.")
  .action(pushSchema);

program
  .command("push-perms")
  .description("Pushes local instant.perms rules to production.")
  .action(pushPerms);

const options = program.opts();
program.parse(process.argv);

// command actions

async function login() {
  const ok = await promptOk(
    "This will open Instant in your brower, OK to proceed?",
  );

  if (!ok) return;

  open(authUrl);

  const { token, email } = await execMagicLocalhostCallback(magicLocalhostPort);

  await saveConfigAuthToken(token);

  console.log(chalk.green(`Successfully logged in as ${email}!`));
}

async function init() {
  const pkgDir = await packageDirectory();
  if (!pkgDir) {
    console.error("Failed to locate app root dir.");
    return;
  }

  const pkgJson = await readJson(join(pkgDir, "package.json"));
  const instantModuleName = pkgJson?.dependencies?.["@instantdb/react"]
    ? "@instantdb/react"
    : "@instantdb/core";

  const schema = await readLocalSchema();
  const { perms } = await readLocalPerms();

  const authToken = await readConfigAuthToken();
  if (!authToken) {
    console.error("Unauthenticated.  Please log in with `instant-cli login`!");
    return;
  }

  const id = randomUUID();
  const token = randomUUID();

  const title = await input({
    message: "Enter a name for your app",
    required: true,
  }).catch(() => null);

  if (!title) {
    console.error("No name provided. Exiting.");
    return;
  }

  const createAppRes = await fetch(`${instantBackendOrigin}/dash/apps`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${authToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ id, title, admin_token: token }),
  });

  if (verbose) {
    console.log(
      "Create response:",
      createAppRes.status,
      createAppRes.statusText,
    );
  }

  if (!createAppRes.ok) {
    console.error("Failed to create app.");
    logApiErrors(await createAppRes.json());
    return;
  }

  console.log(chalk.green(`Successfully created your Instant app "${title}"`));
  console.log(`Your app ID: ${id}`);
  console.log(chalk.underline(appDashUrl(id)));

  if (!schema) {
    const schemaPath = join(pkgDir, "instant.schema.ts");
    await writeFile(
      schemaPath,
      instantSchemaTmpl(title, id, instantModuleName),
      "utf-8",
    );
    console.log("Start building your schema: " + schemaPath);
  } else {
    console.warn(`Make sure to update your app ID in instant.schema!`);
  }

  if (!perms) {
    await writeFile(
      join(pkgDir, "instant.perms.ts"),
      examplePermsTmpl,
      "utf-8",
    );
  }
}

async function pushSchema() {
  const authToken = await readConfigAuthToken();
  const schema = await readLocalSchema();

  const ok = await promptOk(
    "This will immediately update your production schema, OK to proceed?",
  );

  if (!ok) {
    return;
  }

  console.log("Planning...");

  if (!authToken) {
    console.error("Unauthenticated.  Please log in with `login`!");
    return;
  }

  if (!schema) {
    console.error("Missing instant.schema file!");
    return;
  }

  if (!schema.appId) {
    console.error("Missing app ID in instant.schema!");
    return;
  }

  const planRes = await fetch(
    `${instantBackendOrigin}/dash/apps/${schema.appId}/schema/push/plan`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ schema }),
    },
  );

  if (verbose) {
    console.log("Plan response:", planRes.status, planRes.statusText);
  }

  if (!planRes.ok) {
    console.error("Failed to update schema");
    return;
  }

  const planResData = await planRes.json();

  if (verbose) {
    console.log(planResData);
  }

  const steps = planResData.steps;

  if (!steps.length) {
    console.log("No schema changes detected.  Exiting.");
    return;
  }

  console.log();

  console.log(
    "The following changes will be applied to your production schema:",
  );

  for (const [action, attr] of steps) {
    const [, fns, fname] = attr["forward-identity"];
    const [, rns, rname] = attr["reverse-identity"] ?? [null, null, null];

    if (attr["value-type"] === "blob" && fname === "id") {
      console.log(
        `${action === "add-attr" ? chalk.magenta("ADD ENTITY") : chalk.magenta("UPDATE ENTITY")} ${fns}`,
      );
    } else if (attr["value-type"] === "blob") {
      console.log(
        `${action === "add-attr" ? chalk.green("ADD ATTR") : chalk.blue("UPDATE ATTR")} ${fns}.${fname} :: unique=${attr["unique?"]}, indexed=${attr["index?"]}`,
      );
    } else {
      console.log(
        `${action === "add-attr" ? chalk.green("ADD LINK") : chalk.blue("UPDATE LINK")} ${fns}.${fname} <=> ${rns}.${rname}`,
      );
    }
  }

  console.log();

  const okPush = await promptOk("OK to proceed?");

  if (!okPush) return;

  const applyRes = await fetch(
    `${instantBackendOrigin}/dash/apps/${schema.appId}/schema/push/apply`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ schema }),
    },
  );

  if (verbose) {
    console.log("Apply response:", applyRes.status, applyRes.statusText);
  }

  if (applyRes.ok) {
    console.log(chalk.green("Schema updated!"));
  } else {
    console.error("Failed to update schema");
    logApiErrors(await applyRes.json());
  }
}

async function pushPerms() {
  const authToken = await readConfigAuthToken();
  const schema = await readLocalSchema();
  const { perms } = await readLocalPerms();

  const ok = await promptOk(
    "This will immediately replace your production perms with your local perms, OK to proceed?",
  );

  if (!ok) return;

  if (!authToken) {
    console.error("Please log in with `login`!");
    return;
  }

  if (!schema) {
    console.error("Missing instant.schema file!");
    return;
  }

  if (!schema.appId) {
    console.error("Missing app ID in instant.schema!");
    return;
  }

  if (!perms) {
    console.error("Missing instant.perms file!");
    return;
  }

  const permsRes = await fetch(
    `${instantBackendOrigin}/dash/apps/${schema.appId}/rules`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ code: perms }),
    },
  );

  if (verbose) {
    console.log("Apply response:", permsRes.status, permsRes.statusText);
  }

  if (permsRes.ok) {
    console.log("Permissions updated");
  } else {
    console.error("Failed to update permissions");
    logApiErrors(await permsRes.json());
  }
}

function logApiErrors(data) {
  if (data.message) {
    console.error(data.message);
  }

  if (Array.isArray(data?.hint?.errors)) {
    for (const error of data.hint.errors) {
      console.error(`${error.in.join("->")}: ${error.message}`);
    }
  }
}

// utils

async function promptOk(message) {
  if (options.y) return true;

  return await confirm({
    message,
    default: false,
  }).catch(() => false);
}

async function exists(f) {
  try {
    await stat(f);
    return true;
  } catch {
    return false;
  }
}

async function readLocalPerms() {
  const { config, sources } = await loadConfig({
    sources: [
      // load from `instant.perms.xx`
      {
        files: "instant.perms",
        extensions: ["ts", "mts", "cts", "js", "mjs", "cjs", "json"],
      },
    ],
    // if false, the only the first matched will be loaded
    // if true, all matched will be loaded and deep merged
    merge: false,
  });

  return {
    perms: config,
    path: sources.at(0),
  };
}

async function readLocalSchema() {
  return (
    await loadConfig({
      sources: [
        // load from `instant.config.xx`
        {
          files: "instant.schema",
          extensions: ["ts", "mts", "cts", "js", "mjs", "cjs"],
        },
      ],
      // if false, the only the first matched will be loaded
      // if true, all matched will be loaded and deep merged
      merge: false,
    })
  ).config;
}

async function readJson(path) {
  if (!exists(path)) {
    return null;
  }

  try {
    const data = await readFile(path, "utf-8");
    return JSON.parse(data);
  } catch (error) {}

  return null;
}

function getAuthPaths() {
  const { config: appConfigDirPath } = envPaths("instantdb");
  const authConfigFilePath = join(appConfigDirPath, "a");

  return { authConfigFilePath, appConfigDirPath };
}

async function readConfigAuthToken() {
  if (options.token) {
    return options.token;
  }

  const authToken = await readFile(
    getAuthPaths().authConfigFilePath,
    "utf-8",
  ).catch(() => null);

  return authToken;
}

async function saveConfigAuthToken(authToken) {
  const authPaths = getAuthPaths();

  await mkdir(authPaths.appConfigDirPath, {
    recursive: true,
  });

  return writeFile(authPaths.authConfigFilePath, authToken, "utf-8");
}

function execMagicLocalhostCallback(port) {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      res.setHeader("Access-Control-Allow-Origin", instantDashOrigin);
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

      const data = await readReqBody(req).catch(() => {});

      if (!data?.token) {
        res.statusCode = 400;
        res.end();
      } else {
        resolve(data);
        res.statusCode = 200;
        res.end();
        server.close();
      }
    }).listen(port);
  });
}

/**
 * Parses the body of an incoming HTTP message and returns a JSON object.
 * @param {import('http').IncomingMessage} incomingMessage - The incoming HTTP message.
 * @returns {Promise<Object>} - A promise that resolves to a JSON object.
 */
function readReqBody(incomingMessage) {
  return new Promise((resolve, reject) => {
    let body = "";

    incomingMessage.on("data", (chunk) => {
      body += chunk;
    });

    incomingMessage.on("end", () => {
      try {
        const json = JSON.parse(body);
        resolve(json);
      } catch (error) {
        reject(error);
      }
    });

    incomingMessage.on("error", (error) => {
      reject(error);
    });
  });
}

// templates

function appDashUrl(id) {
  return `${instantDashOrigin}/dash?s=main&t=home&app=${id}`;
}

function instantSchemaTmpl(title, id, instantModuleName) {
  return /* ts */ `// ${title}
// ${appDashUrl(id)}

import { i } from "${instantModuleName ?? "@instantdb/core"}";

const INSTANT_APP_ID = "${id}";

// Example entities and links (you can delete these!)
const graph = i.graph(
  INSTANT_APP_ID,
  {
    posts: i.entity({
      name: i.string(),
      content: i.string(),
    }),
    authors: i.entity({
      userId: i.string(),
      name: i.string(),
    }),
    tags: i.entity({
      label: i.string(),
    }),
  },
  {
    authorPosts: {
      forward: {
        on: "authors",
        has: "many",
        label: "posts",
      },
      reverse: {
        on: "posts",
        has: "one",
        label: "author",
      },
    },
    postsTags: {
      forward: {
        on: "posts",
        has: "many",
        label: "tags",
      },
      reverse: {
        on: "tags",
        has: "many",
        label: "posts",
      },
    },
  },
);


export default graph;
`;
}

const examplePermsTmpl = /* ts */ `export default {
  authors: {
    bind: ["isAuthor", "auth.id == data.userId"],
    allow: {
      view: "true",
      create: "isAuthor",
      update: "isAuthor",
      delete: "isAuthor",
    },
  },
  posts: {
    bind: ["isAuthor", "auth.id in data.ref('authors.userId')"],
    allow: {
      view: "true",
      create: "isAuthor",
      update: "isAuthor",
      delete: "isAuthor",
    },
  },
  tags: {
    bind: ["isOwner", "auth.id in data.ref('posts.authors.userId')"],
    allow: {
      view: "true",
      create: "isOwner",
      update: "isOwner",
      delete: "isOwner",
    },
  },
};
`;

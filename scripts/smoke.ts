import { applyDotEnv, loadDotEnv, resolveProviderConfig } from '../src/config.js';
import { createProvider } from '../src/llm/index.js';

interface SmokeArgs {
  provider?: string;
  model?: string;
  prompt?: string;
}

function parseArgs(argv: readonly string[]): SmokeArgs {
  const args: SmokeArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === '--provider' || flag === '--model' || flag === '--prompt') {
      if (next === undefined) throw new Error(`Missing value for ${flag}`);
      if (flag === '--provider') args.provider = next;
      else if (flag === '--model') args.model = next;
      else args.prompt = next;
      i++;
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
applyDotEnv(loadDotEnv());
if (args.provider !== undefined) process.env.PROVIDER = args.provider;
if (args.model !== undefined) process.env.MODEL = args.model;

try {
  const config = resolveProviderConfig();
  const provider = createProvider(config);
  console.log(`provider=${provider.kind} model=${provider.model}`);

  const prompt = args.prompt ?? 'Reply with the single word: OK';
  const started = Date.now();
  const res = await provider.complete(prompt);

  console.log(`response: ${res.text.trim()}`);
  console.log(`reported model: ${res.model}`);
  console.log(`elapsed: ${Date.now() - started} ms`);
  console.log(
    `usage: prompt=${res.usage.promptTokens} completion=${res.usage.completionTokens} total=${res.usage.totalTokens}`,
  );
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
}

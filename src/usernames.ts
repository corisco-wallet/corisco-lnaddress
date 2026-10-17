import { randomInt } from "node:crypto";

const ADJECTIVES = [
  "amber", "bold", "brave", "calm", "clever", "cosmic", "crisp", "daring", "eager", "fancy", "gentle", "golden",
  "happy", "jolly", "keen", "lively", "lucky", "mellow", "nimble", "noble", "quick", "quiet", "rapid", "shiny",
  "silent", "smooth", "solid", "sunny", "swift", "tidy", "vivid", "witty",
];
const NOUNS = [
  "falcon", "otter", "panda", "tiger", "eagle", "badger", "beaver", "cobra", "dolphin", "fox", "gecko", "heron",
  "ibex", "jaguar", "koala", "lemur", "lynx", "marten", "newt", "ocelot", "puffin", "quokka", "raven", "seal",
  "stork", "toucan", "viper", "walrus", "wombat", "yak", "zebra", "condor",
];

export const RESERVED = new Set([
  "admin", "administrator", "root", "support", "help", "info", "abuse", "security", "postmaster", "webmaster",
  "hostmaster", "noreply", "no-reply", "corisco", "wallet", "lnurlp", "lnurl", "well-known", "api", "www", "mail",
  "satoshi", "bitcoin", "lightning", "spark",
]);

const USERNAME_RE = /^[a-z0-9_.-]{3,32}$/;

export function isValidUsername(name: string): boolean {
  return USERNAME_RE.test(name) && !RESERVED.has(name) && !/^[._-]|[._-]$/.test(name);
}

export function generateUsername(): string {
  const adjective = ADJECTIVES[randomInt(ADJECTIVES.length)];
  const noun = NOUNS[randomInt(NOUNS.length)];
  return `${adjective}-${noun}-${String(randomInt(1000)).padStart(3, "0")}`;
}

// Text moderation for user-chosen public identifiers (display name + handle).
//
// Uses `obscenity` with its English recommended dataset + transformers, which
// catch common obfuscation (leetspeak "f4ck", spacing "f u c k", symbol
// substitution) far better than a naive word list, while its whitelist keeps
// the Scunthorpe class of false positives down. We layer a small supplemental
// blocklist for hard slurs we always reject regardless.
//
// One matcher instance is built once at module load and reused (it's stateless
// per-check). Safe on both server and client.

import {
  RegExpMatcher,
  englishDataset,
  englishRecommendedTransformers,
} from 'obscenity';

// Real names the English dataset flags by substring (Dickson, Cummings, Fukuda,
// Annalise, Shitong…). Found by running every player name in the DB through
// the matcher (2026-10-11): 240 of 75k names were rejected. Only a token that
// EXACTLY equals an entry is skipped, so "schinks" or "massashit" still hit.
// Surnames that ARE the blocked word (Dick, Hooker, Cumming) are not listed.
const NAME_WHITELIST = new Set<string>([
  'analese', 'analía', 'analiesse', 'analisa', 'analise', 'analissa', 'analla', 'angga', 'annalee',
  'annaleigh', 'annalena', 'annalie', 'annaliese', 'annalisa', 'annalise', 'annaliza', 'anusauskas',
  'anusha', 'anushka', 'assef', 'asselin', 'asselt', 'burdick', 'chenggang', 'cumens', 'cumiskey',
  'cummings', 'cummins', 'dickason', 'dicke', 'dickemann', 'dicken', 'dicker', 'dickerson',
  'dickert', 'dickey', 'dickie', 'dickinson', 'dickison', 'dickler', 'dickson', 'dickstein', 'dykema',
  'dykeman', 'faagau', 'fackler', 'fagan', 'fage', 'fagin', 'fenedick', 'fu', 'fuka', 'fukasawa',
  'fukaya', 'fukayama', 'fukuchi', 'fukuda', 'fukui', 'fukumori', 'fukumura', 'fukunaga', 'fukuoka',
  'fukushima', 'fuuka', 'gianusso', 'gradick', 'gurganus', 'gyorgy', 'györgy', 'hanus', 'hanusa',
  'hanuushah', 'helbich', 'jiraporn', 'liebich', 'longendyke', 'murdick', 'panuski', 'rapert',
  'reddick', 'redick', 'riddick', 'ringgaard', 'rysdyke', 'sashit', 'schink', 'semenek', 'semenza',
  'semmens', 'peniston', 'penistone', 'shaddick', 'shitindo', 'shitong', 'sluter', 'slutsky', 'tanushree', 'tendick',
  'updyke', 'vandyke', 'vandyken', 'vordick', 'wanken', 'yanalitis',
]);

const matcher = new RegExpMatcher({
  ...englishDataset.build(),
  ...englishRecommendedTransformers,
});

// Supplemental hard blocklist for slurs/phrases we never want, independent of
// the library. Lowercase letters only.
// Substrings: matched anywhere in the text with separators stripped, so
// "n.i.g.g.e.r" hits. Only terms no player name in the DB contains. "neonazi"
// is here rather than a "...nazi" suffix rule because Ashkenazi is a surname.
const BLOCKED_SUBSTRINGS: string[] = [
  'n1gger', 'nigger', 'nigga', 'faggot', 'wetback', 'tranny', 'hitler', 'neonazi',
];
// Whole words only (digits split words, so "nazi88" hits): as substrings these
// hit real names (Cody Spicer, Draper, Cooney, Nazir, "therapist"), 66 players
// in the DB. The cost is that glued forms like "xxspicxx" pass. "coons" and
// "spick" are left out: both are player surnames.
const BLOCKED_WORDS = new Set<string>([
  'spic', 'spics', 'chink', 'chinks', 'kike', 'kikes', 'gook', 'gooks', 'coon',
  'fag', 'fags', 'retard', 'retards', 'rape', 'rapist', 'rapists', 'nazi', 'nazis', 'nazism',
  'kkk', 'kkks',
  // Profanity the matcher only catches standalone; listed so "cock99" and
  // "x_shit_x" hit too. Mirrors the DB's name_is_clean word list.
  'shit', 'shits', 'shitty', 'shithead', 'cock', 'cocks', 'dick', 'dicks', 'dickhead', 'slut',
  'sluts', 'cum', 'porn', 'twat', 'twats', 'tits', 'whore', 'whores', 'asshole', 'assholes', 'cunt',
]);
// Word starts, mirroring the DB ("niggz", "cuntz", "retarded"). Knigge only
// contains "nigg"; "niggle"/"niggling" are real words.
const BLOCKED_PREFIXES = ['nigg', 'retard', 'cunt'];

// Zero-width and soft-hyphen characters someone could slip inside a word.
const INVISIBLE = /[\u00ad\u200b-\u200f\u2060\ufeff]/g;

/** Rejoin a word split by spaces or punctuation: "f u c k", "s,p,i,c",
 *  "fu ck". Joins next to a single character, or between two short parts,
 *  so "Anna Lee" and "Anna Ly" stay two words (joined they hit "anal"). */
function joinFragments(text: string): string {
  const parts = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return parts
    .map((p, i) => {
      if (i === 0) return p;
      const prev = parts[i - 1];
      const join = (p.length <= 2 && prev.length <= 2) || p.length === 1 || prev.length === 1;
      return (join ? '' : ' ') + p;
    })
    .join('');
}

function withoutWhitelistedNames(text: string): string {
  return text.replace(/[\p{L}\p{N}]+/gu, (w) => (NAME_WHITELIST.has(w.toLowerCase()) ? ' ' : w));
}

function hasBlockedTerm(text: string): boolean {
  const lower = text.toLowerCase();
  const stripped = lower.replace(/[^a-z0-9]/g, '');
  if (BLOCKED_SUBSTRINGS.some((bad) => stripped.includes(bad))) return true;
  return lower
    .split(/[^a-z]+/)
    .some(
      (w) =>
        BLOCKED_WORDS.has(w) ||
        (BLOCKED_PREFIXES.some((pre) => w.startsWith(pre)) && !w.startsWith('niggl')),
    );
}

/**
 * True when `text` contains profanity/slurs and must be rejected. Checks the
 * text and its rejoined copy (whitelisted name tokens removed) against the
 * obscenity matcher (obfuscation-aware) and the supplemental blocklist.
 */
export function containsProfanity(text: string): boolean {
  if (!text) return false;
  const visible = text.replace(INVISIBLE, '');
  return [visible, joinFragments(visible)].some((t) => {
    const checked = withoutWhitelistedNames(t);
    return matcher.hasMatch(checked) || hasBlockedTerm(checked);
  });
}

/**
 * Validate a public-facing name (display name OR handle-as-shown). Returns an
 * error string to show the user, or null when the value is acceptable.
 * `field` is used only for the message ("Display name" / "Handle").
 */
export function moderateName(text: string, field = 'Name'): string | null {
  if (containsProfanity(text)) {
    return `${field} contains language that isn't allowed. Please choose another.`;
  }
  return null;
}

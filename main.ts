/**
 * Bot: DAWN RUNNER
 * Bounty: u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122
 * Design: early strong-flow entry, pyramid adds, trailing-stop ride, no fixed take-profit
 */

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));

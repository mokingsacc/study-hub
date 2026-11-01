import SKILL_MD from './qbank-method-text.js';
import { skillBody, METHOD_TEXT_MAX } from './teach-method.js';
import { fnv1a } from './teach-priority.js';

export const QBANK_TEXT = skillBody(SKILL_MD);
export const QBANK_VERSION = fnv1a(SKILL_MD);
export const QBANK_PROBLEMS = QBANK_TEXT.length > METHOD_TEXT_MAX ? [`The qbank method is ${QBANK_TEXT.length} characters; the limit is ${METHOD_TEXT_MAX}.`] : [];
export const qbankMethod = () => ({ version: QBANK_VERSION, text: QBANK_TEXT });

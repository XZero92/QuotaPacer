import type { Language } from "./types";
import {
  createContext,
  createElement,
  useContext,
  type ReactNode,
} from "react";

export const DEFAULT_LANGUAGE: Language = "ko";

export function isLanguage(value: unknown): value is Language {
  return value === "ko" || value === "en";
}

export function text(language: Language, korean: string, english: string) {
  return language === "en" ? english : korean;
}

export function locale(language: Language) {
  return language === "en" ? "en-US" : "ko-KR";
}

const LanguageContext = createContext<Language>(DEFAULT_LANGUAGE);

export function LanguageProvider({
  language,
  children,
}: {
  language: Language;
  children: ReactNode;
}) {
  return createElement(LanguageContext.Provider, { value: language }, children);
}

export function useLanguage() {
  return useContext(LanguageContext);
}

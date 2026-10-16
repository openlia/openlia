import * as matchersModule from "@testing-library/jest-dom/matchers";
import { cleanup } from "@testing-library/react";
import { afterEach, expect } from "vitest";

expect.extend(matchersModule.default ?? matchersModule);

afterEach(() => {
  cleanup();
});

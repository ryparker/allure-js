import { Allure, InMemoryAllureWriter } from "allure-js-commons";

import { JasmineAllureReporter } from "../src/JasmineAllureReporter";
import Env = jasmine.Env;

export interface JasmineTestEnv extends Env {
  expect(actual: any): any;
}

export async function runTest(fun: (testEnv: JasmineTestEnv, testAllure: Allure) => void) {
  const writer = new InMemoryAllureWriter();
  await new Promise((resolve, reject) => {
    const reporter = new JasmineAllureReporter({ writer, resultsDir: "unused" });
    const testEnv: JasmineTestEnv = eval("new jasmine.Env()");
    testEnv.addReporter(reporter);
    testEnv.addReporter({ jasmineDone: resolve });
    const testAllure = reporter.getInterface();
    fun(testEnv, testAllure);
    testEnv.execute();
  });
  return writer;
}

export function delay(ms: number) {
  return new Promise<void>(function(resolve) {
    setTimeout(resolve, ms);
  });
}

export function delayFail(ms: number) {
  return new Promise<void>(function(resolve, reject) {
    setTimeout(() => reject(new Error("Async error")), ms);
  });
}

/*
todo:
strip ansi
failing test +

throwing test

skipped test ++

test pending with reason +
test nested in 3 describes

async passing test
async failing test

attach text
attach inside step

step +
nested step ++
failing step ~
 */

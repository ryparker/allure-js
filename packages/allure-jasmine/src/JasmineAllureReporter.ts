import {
  Allure,
  AllureGroup,
  AllureRuntime,
  AllureStep,
  AllureTest,
  ContentType,
  ExecutableItemWrapper,
  IAllureConfig,
  Label,
  LabelName,
  Stage,
  Status,
  StepInterface,
  isPromise,
} from "allure-js-commons";

import path from "path";
import stripAnsi from "strip-ansi";

import FailedExpectation = jasmine.FailedExpectation;

enum SpecStatus {
  PASSED = "passed",
  FAILED = "failed",
  BROKEN = "broken",
  PENDING = "pending",
  DISABLED = "disabled",
  EXCLUDED = "excluded",
  TODO = "todo",
}

export type Attachment = {
  name: string;
  content: Buffer | string;
  type: ContentType;
};

export interface JAllureConfig extends IAllureConfig {
  projectDir?: string;
}

type JasmineBeforeAfterFn = (action: (done: DoneFn) => void, timeout?: number) => void;

export class JasmineAllureReporter implements jasmine.CustomReporter {
  private config: JAllureConfig;
  private groupStack: AllureGroup[] = [];
  private labelStack: Label[][] = [[]];
  private runningTest: AllureTest | null = null;
  private stepStack: AllureStep[] = [];
  public runningExecutable: ExecutableItemWrapper | null = null;
  private isSuite: Boolean = false;

  private readonly runtime: AllureRuntime;

  constructor(config: JAllureConfig) {
    this.config = config;
    this.runtime = new AllureRuntime(config);
    this.installHooks();
  }

  private getCurrentGroup(): AllureGroup | null {
    if (this.groupStack.length === 0) return null;
    return this.groupStack[this.groupStack.length - 1];
  }

  get currentGroup(): AllureGroup {
    const currentGroup = this.getCurrentGroup();
    if (currentGroup === null) throw new Error("No active group");
    return currentGroup;
  }

  getInterface(): JasmineAllureInterface {
    return new JasmineAllureInterface(this, this.runtime);
  }

  get currentTest(): AllureTest {
    if (this.runningTest === null) throw new Error("No active test");
    return this.runningTest;
  }

  get currentExecutable(): ExecutableItemWrapper | null {
    return this.runningExecutable;
  }

  writeAttachment(content: Buffer | string, type: ContentType): string {
    return this.runtime.writeAttachment(content, type);
  }

  jasmineStarted(suiteInfo: jasmine.SuiteInfo): void {
    console.log(`Jest Worker #${process.env.JEST_WORKER_ID} has started.`);
  }

  suiteStarted(suite: jasmine.CustomReporterResult): void {
    // suiteStarted is only triggered when a test is nested in a describe block
    this.isSuite = true;

    // Group all specs of describe block together using wrapper.
    const name = suite.description;
    const group = (this.getCurrentGroup() || this.runtime).startGroup(name);

    this.groupStack.push(group);
    this.labelStack.push([]);
  }

  specStarted(spec: jasmine.CustomReporterResult): void {
    let specPathArr = [];

    // Special behavior if test is not using describe blocks
    if (!this.isSuite) {
      const { projectDir } = this.config;
      const { testPath } = spec as any;

      specPathArr = projectDir ? path.relative(projectDir, testPath).split("/") : testPath.split("/");

      if (specPathArr.length > 0) {
        const group = (this.getCurrentGroup() || this.runtime).startGroup(specPathArr[0]);
        this.groupStack.push(group);
        this.labelStack.push([]);
      }
    }

    // Checking current context
    let currentGroup = this.getCurrentGroup();
    if (currentGroup === null) throw new Error("No active suite");

    // Wrapper to hold beforeEach/afterEach
    currentGroup = currentGroup.startGroup("Test wrapper");
    this.groupStack.push(currentGroup);

    // Starting test
    const specName = spec.description;
    const allureTest = currentGroup.startTest(specName);

    // Check context for invalid state
    if (this.runningTest != null) throw new Error("Test is starting before other ended!");

    // Set context state
    this.runningTest = allureTest;

    allureTest.fullName = spec.fullName;
    allureTest.historyId = spec.fullName;
    allureTest.stage = Stage.RUNNING;

    // If describe blocks are being used, then use describe block names for report organization.
    if (this.isSuite) {
      if (this.groupStack.length > 1) {
        allureTest.addLabel(LabelName.PARENT_SUITE, this.groupStack[0].name);
      }
      if (this.groupStack.length > 2) {
        allureTest.addLabel(LabelName.SUITE, this.groupStack[1].name);
      }
      if (this.groupStack.length > 3) {
        allureTest.addLabel(LabelName.SUB_SUITE, this.groupStack[2].name);
      }
    }

    // If test is not using describe blocks, then use file path for report organization.
    // Note: ignore the beforeEach/afterEach wrapper, index + 1
    if (!this.isSuite && specPathArr.length > 1) {
      // Lowest level is the test file name (ie: functionality.test.js)
      allureTest.addLabel(LabelName.SUB_SUITE, specPathArr[specPathArr.length - 1]);

      // Next level is the test file's dir name (ie: POST/GET/PUT/DELETE)
      allureTest.addLabel(LabelName.SUITE, specPathArr[specPathArr.length - 2]);

      // Top level is the rest of the file path (ie: user/info)
      allureTest.addLabel(LabelName.PARENT_SUITE, specPathArr.slice(0, specPathArr.length - 2).join("/"));

      // Packages tab should be organized by root folder of file path. (ie: user)
      allureTest.addLabel(LabelName.PACKAGE, specPathArr[0]);
    }

    // Capture Jest worker thread for timeline report
    if (process.env.JEST_WORKER_ID) this.addLabel(LabelName.THREAD, `${process.env.JEST_WORKER_ID}`);

    // Recursively add labels to the test instance
    for (const labels of this.labelStack) {
      for (const label of labels) {
        allureTest.addLabel(label.name, label.value);
      }
    }
  }

  specDone(spec: jasmine.CustomReporterResult): void {
    if (this.runningTest === null) throw new Error("specDone while no test is running");

    const currentTest = this.runningTest;

    // If steps were not finished before the spec finished, then notify and clear stepStack.
    if (this.stepStack.length > 0) {
      console.error("Allure reporter issue: step stack is not empty on specDone");

      for (const step of this.stepStack.reverse()) {
        step.status = Status.BROKEN;
        step.stage = Stage.INTERRUPTED;
        step.detailsMessage = "Test ended unexpectedly before step could complete.";
        step.endStep();
      }
      this.stepStack = [];
    }

    // Capture test result/status
    if (spec.status === SpecStatus.PASSED) {
      currentTest.status = Status.PASSED;
      currentTest.stage = Stage.FINISHED;
    }

    if (spec.status === SpecStatus.BROKEN) {
      currentTest.status = Status.BROKEN;
      currentTest.stage = Stage.FINISHED;
    }

    if (spec.status === SpecStatus.FAILED) {
      currentTest.status = Status.FAILED;
      currentTest.stage = Stage.FINISHED;
    }

    if (
      spec.status === SpecStatus.PENDING ||
      spec.status === SpecStatus.DISABLED ||
      spec.status === SpecStatus.EXCLUDED ||
      spec.status === SpecStatus.TODO
    ) {
      currentTest.status = Status.SKIPPED;
      currentTest.stage = Stage.PENDING;
      currentTest.detailsMessage = spec.pendingReason || "Suite disabled";
    }

    // Capture exceptions
    const exceptionInfo =
      this.findMessageAboutThrow(spec.failedExpectations) || this.findAnyError(spec.failedExpectations);

    if (exceptionInfo !== null && typeof exceptionInfo.message === "string") {
      let { message } = exceptionInfo;

      message = stripAnsi(message);

      currentTest.detailsMessage = message;

      if (exceptionInfo.stack && typeof exceptionInfo.stack === "string") {
        let { stack } = exceptionInfo;

        stack = stripAnsi(stack);
        stack = stack.replace(message, "");

        currentTest.detailsTrace = stack;
      }
    }

    // Finished with test
    currentTest.endTest();
    this.runningTest = null;

    // Popping test wrapper
    this.currentGroup.endGroup();
    this.groupStack.pop();

    // If test was not in a describe block, end the group wrapper
    if (!this.isSuite) {
      const currentGroup = this.getCurrentGroup();

      if (currentGroup === null) throw new Error("No active suite");

      currentGroup.endGroup();
      this.groupStack.pop();
      this.labelStack.pop();
    }
  }

  suiteDone(suite: jasmine.CustomReporterResult): void {
    if (!this.isSuite) console.error("Allure reporter issue: suiteDone called without suiteStart context.");

    if (this.runningTest !== null) console.error("Allure reporter issue: A test was running on suiteDone.");

    const currentGroup = this.getCurrentGroup();

    if (currentGroup === null) throw new Error("No active suite.");

    currentGroup.endGroup();
    this.groupStack.pop();
    this.labelStack.pop();
  }

  jasmineDone(runDetails: jasmine.RunDetails): void {
    console.log(`Jest Worker #${process.env.JEST_WORKER_ID} has finished.`);
  }

  private findMessageAboutThrow(expectations?: FailedExpectation[]): FailedExpectation | null {
    for (const e of expectations || []) {
      if (e.matcherName === "") return e;
    }
    return null;
  }

  private findAnyError(expectations?: FailedExpectation[]): FailedExpectation | null {
    expectations = expectations || [];
    if (expectations.length > 0) return expectations[0];
    return null;
  }

  addLabel(name: string, value: string): void {
    if (this.labelStack.length) {
      this.labelStack[this.labelStack.length - 1].push({ name, value });
    }
  }

  pushStep(step: AllureStep): void {
    this.stepStack.push(step);
  }

  popStep(): void {
    this.stepStack.pop();
  }

  get currentStep(): AllureStep | null {
    if (this.stepStack.length > 0) return this.stepStack[this.stepStack.length - 1];
    return null;
  }

  // TODO: Add support for manually adding setup execution steps.

  private installHooks() {
    const reporter = this;
    const jasmineBeforeAll: JasmineBeforeAfterFn = eval("global.beforeAll");
    const jasmineAfterAll: JasmineBeforeAfterFn = eval("global.afterAll");
    const jasmineBeforeEach: JasmineBeforeAfterFn = eval("global.beforeEach");
    const jasmineAfterEach: JasmineBeforeAfterFn = eval("global.afterEach");

    function makeWrapperAll(wrapped: JasmineBeforeAfterFn, fun: () => ExecutableItemWrapper) {
      return function (action: (done: DoneFn) => void, timeout?: number): void {
        wrapped(function (done) {
          reporter.runningExecutable = fun();
          let ret;
          if (action.length > 0) {
            // function takes done callback
            ret = reporter.runningExecutable.wrap(
              () =>
                new Promise((resolve, reject) => {
                  const t: any = resolve;
                  t.fail = reject;
                  action(t);
                })
            )();
          } else {
            ret = reporter.runningExecutable.wrap(action)();
          }
          if (isPromise(ret)) {
            (ret as Promise<any>)
              .then(() => {
                reporter.runningExecutable = null;
                done();
              })
              .catch((e) => {
                reporter.runningExecutable = null;
                done.fail(e);
              });
          } else {
            reporter.runningExecutable = null;
            done();
          }
        }, timeout);
      };
    }
    const wrapperBeforeAll = makeWrapperAll(jasmineBeforeAll, () => reporter.currentGroup.addBefore());
    const wrapperAfterAll = makeWrapperAll(jasmineAfterAll, () => reporter.currentGroup.addAfter());
    const wrapperBeforeEach = makeWrapperAll(jasmineBeforeEach, () => reporter.currentGroup.addBefore());
    const wrapperAfterEach = makeWrapperAll(jasmineAfterEach, () => reporter.currentGroup.addAfter());

    eval("global.beforeAll = wrapperBeforeAll;");
    eval("global.afterAll = wrapperAfterAll;");
    eval("global.beforeEach = wrapperBeforeEach;");
    eval("global.afterEach = wrapperAfterEach;");
  }
}

//TODO: Move this to it's own file
export class JasmineAllureInterface extends Allure {
  constructor(private readonly reporter: JasmineAllureReporter, runtime: AllureRuntime) {
    super(runtime);
  }

  private startStep(name: string): WrappedStep {
    const allureStep: AllureStep = this.currentExecutable.startStep(name);

    this.reporter.pushStep(allureStep);

    return new WrappedStep(this.reporter, allureStep);
  }

  protected get currentExecutable(): ExecutableItemWrapper {
    return this.reporter.currentStep || this.reporter.currentExecutable || this.reporter.currentTest;
  }

  protected get currentTest(): AllureTest {
    return this.reporter.currentTest;
  }

  public setup<T>(body: () => any): any {
    this.reporter.runningExecutable = this.reporter.currentGroup.addBefore();

    const result = this.reporter.runningExecutable.wrap(body)();

    if (isPromise(result)) {
      const promise = result as Promise<any>;
      return promise
        .then((a) => {
          this.reporter.runningExecutable = null;
          return a;
        })
        .catch((e) => {
          this.reporter.runningExecutable = null;
          throw e;
        });
    }

    if (!isPromise(result)) {
      this.reporter.runningExecutable = null;
      return result;
    }
  }

  public step<T>(name: string, body: (step: StepInterface) => any): any {
    const wrappedStep = this.startStep(name);
    let result;

    try {
      result = wrappedStep.run(body);
    } catch (err) {
      wrappedStep.endStep();
      throw err;
    }

    if (isPromise(result)) {
      const promise = result as Promise<any>;
      return promise
        .then((a) => {
          wrappedStep.endStep();
          return a;
        })
        .catch((e) => {
          wrappedStep.endStep();
          throw e;
        });
    }

    if (!isPromise(result)) {
      wrappedStep.endStep();
      return result;
    }
  }

  public logStep(name: string, status: Status, attachments?: [Attachment]): void {
    const wrappedStep = this.startStep(name);

    if (attachments) {
      for (const { name, content, type } of attachments) {
        this.attachment(name, content, type);
      }
    }

    wrappedStep.logStep(status);
    wrappedStep.endStep();
  }

  public attachment(name: string, content: Buffer | string, type: ContentType) {
    const file = this.reporter.writeAttachment(content, type);

    this.currentExecutable.addAttachment(name, type, file);
  }

  // public parameter(name: string, value: string): void {
  //   this.label(name, value);
  // }

  public label(name: string, value: string): void {
    try {
      this.reporter.currentTest.addLabel(name, value);
    } catch {
      this.reporter.addLabel(name, value);
    }
  }
}

//TODO: Move this to it's own file
class WrappedStep {
  constructor(private readonly reporter: JasmineAllureReporter, private readonly step: AllureStep) {}

  startStep(name: string): WrappedStep {
    const step = this.step.startStep(name);
    this.reporter.pushStep(step);
    return new WrappedStep(this.reporter, step);
  }

  attach(name: string, content: Buffer | string, type: ContentType): void {
    const file = this.reporter.writeAttachment(content, type);
    this.step.addAttachment(name, type, file);
  }

  param(name: string, value: string): void {
    this.step.addParameter(name, value);
  }

  logStep(status: Status): void {
    return this.step.logStep(status);
  }

  run<T>(body: (step: StepInterface) => T): T {
    return this.step.wrap(body)();
  }

  endStep(): void {
    this.reporter.popStep();
    this.step.endStep();
  }
}

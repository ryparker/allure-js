import { ContentType, FixtureResult, Stage, Status, StatusDetails, StepResult, TestResult } from "./model";

import { isPromise } from "./isPromise";
import { stepResult } from "./constructors";

// import stripAnsi from "strip-ansi";

export class ExecutableItemWrapper {
  constructor(private readonly info: FixtureResult | TestResult) {}

  protected get wrappedItem(): FixtureResult | TestResult {
    return this.info;
  }

  public set name(name: string) {
    this.info.name = name;
  }

  public set description(description: string) {
    this.info.description = description;
  }

  public set descriptionHtml(descriptionHtml: string) {
    this.info.descriptionHtml = descriptionHtml;
  }

  public set status(status: Status | undefined) {
    this.info.status = status;
  }

  public get status() {
    return this.info.status;
  }

  public set statusDetails(details: StatusDetails) {
    this.info.statusDetails = details;
  }

  public set detailsMessage(message: string) {
    this.info.statusDetails.message = message;
  }

  public set detailsTrace(trace: string) {
    this.info.statusDetails.trace = trace;
  }

  public set stage(stage: Stage) {
    this.info.stage = stage;
  }

  public addParameter(name: string, value: string) {
    this.info.parameters.push({ name, value });
  }

  public addAttachment(name: string, type: ContentType, fileName: string) {
    // eslint-disable-next-line object-shorthand
    this.info.attachments.push({ name, type, source: fileName });
  }

  public startStep(name: string): AllureStep {
    const result = stepResult();
    this.info.steps.push(result);

    const allureStep = new AllureStep(result);
    allureStep.name = name;
    return allureStep;
  }

  public logStep(status: Status) {
    this.stage = Stage.FINISHED;
    this.status = status;
  }

  public wrap<T>(fun: (...args: any[]) => any) {
    return (...args: any[]) => {
      this.stage = Stage.RUNNING;
      let result;

      try {
        result = fun(args);
      } catch (error) {
        if (error.stack || error.message) {
          if (error.stack && error.message) {
            this.status = Status.FAILED;
            this.stage = Stage.FINISHED;

            const { message, stack } = error as Error;

            this.detailsMessage = message || "";
            this.detailsTrace = stack || "";

            if (this.detailsTrace) {
              this.detailsTrace = this.detailsTrace.replace(this.detailsMessage, "");
            }
          }

          result = error;
        }
      }

      if (isPromise(result)) {
        const promise = result as Promise<any>;
        return promise
          .then(res => {
            if (!this.status) this.status = Status.PASSED;

            this.stage = Stage.FINISHED;

            return res;
          })
          .catch(error => {
            this.stage = Stage.INTERRUPTED;

            if (!this.status) this.status = Status.BROKEN;

            if (error) {
              if (error.stack && error.message) {
                this.status = Status.FAILED;
                this.stage = Stage.FINISHED;

                const { message, stack } = error as Error;

                this.detailsMessage = message || "";
                this.detailsTrace = stack || "";

                if (this.detailsTrace) {
                  this.detailsTrace = this.detailsTrace.replace(this.detailsMessage, "");
                }
              }
            }

            result = error;
          });
      } else {
        if (!this.status) this.status = Status.PASSED;

        this.stage = Stage.FINISHED;

        return result;
      }
    };
  }
}

// This class is here because of circular dependency with ExecutableItemWrapper
export class AllureStep extends ExecutableItemWrapper {
  constructor(private readonly stepResult: StepResult) {
    super(stepResult);
    this.stepResult.start = Date.now();
  }

  endStep() {
    this.stepResult.stop = Date.now();
    // TODO: test that child steps ended
  }
}

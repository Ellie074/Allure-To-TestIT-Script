import * as tl from 'azure-pipelines-task-lib/task'

const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const FormData = require('form-data');

interface AllureStep {
    name: string;
    steps?: AllureStep[];
    attachments: any[];
    parameters?: { name: string; value: string }[];
    status?: string;
    start?: number;
    stop?: number;
}

interface StepSpec {
    title: string;
    steps: StepSpec[];
}

interface StepResult {
    title: string;
    stepResults: any[];
    outcome: string;
    duration: number;
    parameters: { [key: string]: string };
    attachments: any[];
}

interface AllureResult {
    historyId: string;
    name: string;
    steps?: AllureStep[];
    labels?: { name: string; value: string }[];
    start?: number;
    stop?: number;
    status?: string;
    attachments?: AttachRef[];
    statusDetails: StatusDetails;
}

interface StatusDetails {
    message: string;
    trace: string;
}

interface AttachRef {
    id: any;
}

interface Args {
    inputDir: string;
    url: string;
    token: string;
    projectId: string;
    configurationId: string;
    testRunName: string;
}

const main = async (): Promise<void> => {

     let disableNodeTlsCheck = tl.getBoolInput('disableNodeTlsCheck')
     let reportsFolder = tl.getInput('allureReportsFolder') || ''
     let projectId = tl.getInput('projectId') || ''
     let configurationId = tl.getInput('configurationId') || ''
     let testRunName = tl.getInput('testRunName') || ''

     let testitEndpoint = tl.getInput("testItConnectedService") || ''
     let endpointUrl = tl.getEndpointUrl(testitEndpoint, true) || ''
     let token = tl.getEndpointAuthorizationParameter(testitEndpoint, 'password', true) || ''

     if (!endpointUrl || !token) {
       tl.setResult(tl.TaskResult.Failed, `Check Test It service connection`)
     }

     if (disableNodeTlsCheck) {
       process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0'
     }

    const args: Args = {
        inputDir: reportsFolder,
        url: endpointUrl,
        token: token,
        projectId: projectId,
        configurationId: configurationId,
        testRunName: testRunName
    };

    await runImport(args);

    tl.setResult(tl.TaskResult.Succeeded, 'Task completed')
    process.exit(0)
};

const runImport = async (args: Args): Promise<void> => {
    const loaded = loadAllureResults(args.inputDir);

    const existingTestRun = await invokeApi(args, 'POST', `api/v2/testRuns/search`, {
        body: {
            projectId: args.projectId,
            name: args.testRunName,
        },
    });
    let testRunId;

    const matchingTestRun = existingTestRun.find((run: any) => run.name === args.testRunName);
    if (matchingTestRun) {
        testRunId = matchingTestRun.id;
        console.log(`Using existing test run with ID: ${testRunId}`);
    } else {
        const testRunResp = await invokeApi(args, 'POST', 'api/v2/testRuns', {
            body: {
                projectId: args.projectId,
                name: args.testRunName,
            },
        });
        testRunId = testRunResp.id;
    }   

    for (let testResult of Object.values(loaded.results)) {
        const autotestMatches = await invokeApi(args, 'POST','api/v2/autoTests/search', {
            body: {
                filter: {
                    isDeleted: false,
                    projectIds: [args.projectId],
                    externalIds: [testResult.historyId],
                }
            },
        });

        const [stepSpecs, stepResults] = await processAllureSteps(args, testResult.steps ?? []);

        const labelObj = Object.fromEntries((testResult.labels ?? []).map(it => [it.name, it.value]));

        const autotestData = {
            externalId: testResult.historyId,
            projectId: args.projectId,
            name: testResult.name,
            steps: stepSpecs,
            classname: labelObj.testClass,
            namespace: labelObj.package,
        };

        if (autotestMatches.length) {
            console.log(`Updating autotest ${testResult.name}`);

            await invokeApi(args, 'PUT','api/v2/autoTests', {
                body: {
                    id: autotestMatches[0].id,
                    ...autotestData,
                },
            });
        } else {
            console.log(`Creating autotest ${testResult.name}`);

            await invokeApi(args, 'POST', 'api/v2/autoTests', {
                body:{ 
                    configurationId: args.configurationId,
                    ...autotestData,
                    duration: testResult.start && testResult.stop ? (testResult.stop - testResult.start) : 0,
                    startedOn: convertAllureTimestamp(testResult.start),
                    completedOn: convertAllureTimestamp(testResult.stop),
                    outcome: allureStatusToOutcome(testResult.status),
                    stepResults: stepResults,
                },
            });
        }

        await invokeApi(args, 'POST', `api/v2/testRuns/${testRunId}/testResults`, {
            body: [{
                configurationId: args.configurationId,
                autoTestExternalId: testResult.historyId,
                duration: testResult.start && testResult.stop ? (testResult.stop - testResult.start) : 0,
                startedOn: convertAllureTimestamp(testResult.start),
                completedOn: convertAllureTimestamp(testResult.stop),
                outcome: allureStatusToOutcome(testResult.status),
                stepResults: stepResults,
                attachments: await uploadAllureAttachments(args, testResult.attachments ?? []),
                message: testResult.statusDetails.message,
                trace: testResult.statusDetails.trace
            }],
        });
    }
};

const allureStatusToOutcome = (status: string | undefined): string => {
    if (status === undefined) {
        return 'Blocked';
    } else if (status === 'passed') {
        return 'Passed';
    } else if (status === 'skipped') {
        return 'Skipped';
    } else {
        return 'Failed';
    }
};

const processAllureSteps = async (args: Args, allureSteps: AllureStep[]): Promise<[StepSpec[], StepResult[]]> => {
    const stepSpecs: StepSpec[] = [];
    const stepResults: StepResult[] = [];

    for (const allureStep of allureSteps) {
        if (!allureStep.name) {
            continue;
        }

        const [innerSpecs, innerResults] = await processAllureSteps(args, allureStep.steps ?? []);

        const stepSpec: StepSpec = {
            title: allureStep.name,
            steps: innerSpecs
        };

        const stepResult: StepResult = {
            title: allureStep.name,
            stepResults: innerResults,
            outcome: allureStatusToOutcome(allureStep.status),
            duration: allureStep.start && allureStep.stop ? (allureStep.stop - allureStep.start) : 0,
            parameters: Object.fromEntries((allureStep.parameters ?? []).map(param => [param.name, param.value])),
            attachments: await uploadAllureAttachments(args, allureStep.attachments ?? []),
        };

        stepSpecs.push(stepSpec);
        stepResults.push(stepResult);
    }

    return [stepSpecs, stepResults];
};

const uploadAllureAttachments = async (args: Args, allureAttachments: any[]): Promise<any[]> => {
    const attachRefs: any[] = [];

    for (const attach of allureAttachments) {
        const filePath = path.join(args.inputDir, attach.source);
        const attachBuffer = await fs.promises.readFile(filePath);;
        if (attachBuffer.length === 0) {
            continue;
        }

        const resp = await invokeApiAttachementUpload(args, attach.source, attachBuffer, attach.type);
        attachRefs.push({ id: resp.id });
    }

    return attachRefs;
};

const invokeApiAttachementUpload = async (args: Args, name: string, attachBuffer: Buffer, contentType: string): Promise<any> => {
    const formData = new FormData();
    formData.append('file', attachBuffer, { filename: name, contentType: contentType});

    const headers = {
        ...apiAuthHeaders(args),
    };

    const resp = await fetch(`${args.url}api/v2/attachments`, {
        method: 'POST',
        headers: headers,
        body: formData
    });
    await apiEnsureStatus(resp);
    return await resp.json();
};

const convertAllureTimestamp = (value: number | undefined): string | null => (value ? (new Date(value)).toISOString() : null);

const invokeApi = async (args: Args, method: string, relUrl: string, { body }: { body: any }): Promise<any> => {
    const resp = await fetch(`${args.url}${relUrl}`, {
        method: method,
        headers: {
            ...apiAuthHeaders(args),
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });

    await apiEnsureStatus(resp);
    if (resp.status === 204) {
        return null;
    }
    return await resp.json();
};

const apiAuthHeaders = (args: Args): { [key: string]: string } => ({
    'Authorization': `PrivateToken ${args.token}`,
});

const apiEnsureStatus = async (resp: Response): Promise<void> => {
    if (!resp.ok) {
        console.error(await resp.text());
        throw new Error(`api returned ${resp.status} for ${resp.url}`);
    }
};

const loadAllureResults = (dir: string): { results: { [key: string]: AllureResult } } => {
    const dirEntries = fs.readdirSync(dir);

    const resultFiles = dirEntries
        .filter((name: string) => name.endsWith('-result.json'))
        .map(name => {
            const filePath = path.join(dir, name);
            const fileContent = fs.readFileSync(filePath, 'utf-8');
            return JSON.parse(fileContent);
        });

    resultFiles.sort((it1, it2) => (it1.start ?? 0) - (it2.start ?? 0));

    const results = Object.fromEntries(resultFiles.map(it => [it.historyId, it]));

    return { results };
};

main();
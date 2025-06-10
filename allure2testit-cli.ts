import { fetch } from 'node-fetch';
import * as path from 'path';
import * as fs from 'fs';
import FormData from 'form-data';

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
    try {
        const args = parseArgs();
        await runImport(args);
        console.log('Import completed successfully');
        process.exit(0);
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
};

const parseArgs = (): Args => {
    const args = process.argv.slice(2);
    if (args.length < 6) {
        console.error('Usage: ts-node allure2testit-cli.ts <inputDir> <url> <token> <projectId> <configurationId> <testRunName>');
        console.error('Example:');
        console.error('ts-node allure2testit-cli.ts ./allure-results https://testit.example/ myPrivateToken 123e4567-e89b-12d3-a456-426614174000 987e6543-e21b-43d3-b456-426614174000 "Test Run 1"');
        process.exit(1);
    }

    return {
        inputDir: path.resolve(args[0]),
        url: args[1].endsWith('/') ? args[1] : args[1] + '/',
        token: args[2],
        projectId: args[3],
        configurationId: args[4],
        testRunName: args[5]
    };
};

const runImport = async (args: Args): Promise<void> => {
    console.log('Starting import with parameters:');
    console.log(`- Input directory: ${args.inputDir}`);
    console.log(`- TestIT URL: ${args.url}`);
    console.log(`- Project ID: ${args.projectId}`);
    console.log(`- Configuration ID: ${args.configurationId}`);
    console.log(`- Test Run Name: ${args.testRunName}`);

    const loaded = loadAllureResults(args.inputDir);
    console.log(`Found ${Object.keys(loaded.results).length} test results`);

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
        console.log('Creating new test run');
        const testRunResp = await invokeApi(args, 'POST', 'api/v2/testRuns', {
            body: {
                projectId: args.projectId,
                name: args.testRunName,
            },
        });
        testRunId = testRunResp.id;
        console.log(`Created test run with ID: ${testRunId}`);
    }

    for (const [index, testResult] of Object.entries(Object.values(loaded.results))) {
        console.log(`\nProcessing test ${parseInt(index) + 1}/${Object.keys(loaded.results).length}: ${testResult.name}`);

        const autotestMatches = await invokeApi(args, 'POST', 'api/v2/autoTests/search', {
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
            console.log(`Updating existing autotest (ID: ${autotestMatches[0].id})`);
            await invokeApi(args, 'PUT', 'api/v2/autoTests', {
                body: {
                    id: autotestMatches[0].id,
                    ...autotestData,
                },
            });
        } else {
            console.log('Creating new autotest');
            await invokeApi(args, 'POST', 'api/v2/autoTests', {
                body: { 
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

        console.log('Adding test result to test run');
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
        if (!fs.existsSync(filePath)) {
            console.warn(`Attachment file not found: ${filePath}`);
            continue;
        }

        const attachBuffer = await fs.promises.readFile(filePath);
        if (attachBuffer.length === 0) {
            console.warn(`Empty attachment: ${filePath}`);
            continue;
        }

        console.log(`Uploading attachment: ${attach.source}`);
        const resp = await invokeApiAttachementUpload(args, attach.source, attachBuffer, attach.type);
        attachRefs.push({ id: resp.id });
    }

    return attachRefs;
};

const invokeApiAttachementUpload = async (args: Args, name: string, attachBuffer: Buffer, contentType: string): Promise<any> => {
    const formData = new FormData();
    formData.append('file', attachBuffer, { filename: name, contentType: contentType});

    const resp = await fetch(`${args.url}api/v2/attachments`, {
        method: 'POST',
        headers: apiAuthHeaders(args),
        body: formData
    });
    await apiEnsureStatus(resp);
    return await resp.json();
};

const convertAllureTimestamp = (value: number | undefined): string | null => (value ? (new Date(value)).toISOString() : null);

const invokeApi = async (args: Args, method: string, relUrl: string, { body }: { body: any }): Promise<any> => {
    const url = `${args.url}${relUrl}`;
    console.debug(`API call: ${method} ${url}`);

    const resp = await fetch(url, {
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
        const errorText = await resp.text();
        console.error(`API Error: ${resp.status} ${resp.statusText} for ${resp.url}`);
        console.error(errorText);
        throw new Error(`API returned ${resp.status}`);
    }
};

const loadAllureResults = (dir: string): { results: { [key: string]: AllureResult } } => {
    if (!fs.existsSync(dir)) {
        throw new Error(`Directory not found: ${dir}`);
    }

    const dirEntries = fs.readdirSync(dir);
    const resultFiles = dirEntries
        .filter(name => name.endsWith('-result.json'))
        .map(name => {
            const filePath = path.join(dir, name);
            try {
                const fileContent = fs.readFileSync(filePath, 'utf-8');
                return JSON.parse(fileContent);
            } catch (e) {
                console.error(`Error parsing file ${filePath}:`, e);
                return null;
            }
        })
        .filter(Boolean);

    if (resultFiles.length === 0) {
        throw new Error(`No Allure result files found in ${dir}`);
    }

    resultFiles.sort((it1, it2) => (it1.start ?? 0) - (it2.start ?? 0));
    const results = Object.fromEntries(resultFiles.map(it => [it.historyId, it]));

    return { results };
};

main();
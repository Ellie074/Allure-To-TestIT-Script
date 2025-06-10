# Allure to Test IT Importer

![Test Management](https://img.shields.io/badge/Test-Management-blue) 
![Allure](https://img.shields.io/badge/Integration-Allure-orange) 
![TestIT](https://img.shields.io/badge/Integration-TestIT-green)

## Description

This script imports Allure test results into Test IT (Test Management System). It processes Allure report files, converts them into Test IT format, and uploads them to a specified project in Test IT.

## Features

- Processes Allure test results (JSON files)
- Creates or updates autotests in Test IT
- Creates a test run in Test IT
- Handles test steps hierarchy
- Uploads attachments (screenshots, logs, etc.)
- Supports TLS verification toggle

## Requirements

- Node.js (v14 or higher recommended)
- TypeScript (if running via ts-node)

## Installing dependencies

```bash
npm install node-fetch@2 form-data @types/node @types/form-data 
```

### Usage (Azure DevOps Task version)

1. Create a service connection to Test IT in Azure DevOps (TFS)
2. Add this task to your pipeline
3. Configure the following parameters:

   | Parameter | Description |
   |-----------|-------------|
   | `allureReportsFolder` | Path to Allure results directory |
   | `projectId` | Test IT project ID |
   | `configurationId` | Test IT configuration ID |
   | `testRunName` | Name for the test run in Test IT |
   | `testItConnectedService` | Name of the Test IT service connection |
   | `disableNodeTlsCheck` | Disable TLS certificate verification (optional) |

### Command Line Version

An alternative version is available where parameters are passed directly via command line arguments. See [`allure2testit-cli.ts`](allure2testit-cli.ts) in the repository.

## Command Line Usage

```bash
node allure2testit-cli.js <inputDir> <url> <token> <projectId> <configurationId> <testRunName>
```



# Agent Development Guide

A file for coding agents.

## Commands

- Formatting: `bun fmt`
- Typechecking: `bunx tsc --noEmit`
- Testing: `bun test`

## Directory Structure

- `index.ts`: omp extension entry point
- `lib/`: Source code and unit tests

## Development Guidelines

1. Never commit code. Leave all changes unstaged.
2. Development isn't done until all code is formatted (`bun fmt`), typecheck passes, all tests pass, and tests exist for the changed code.
3. Abide by the following principle as much as possible without sacrificing clarity or correctness: make illegal state unrepresentable.
4. All code needs to be easily testable with automated unit tests.
5. Do not add comments unless they explain what the code cannot.

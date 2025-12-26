# Introduction

This document outlines the overall project architecture for the ILP Connector with BTP and Network Visualization, including backend systems, shared services, and non-UI specific concerns. Its primary goal is to serve as the guiding architectural blueprint for AI-driven development, ensuring consistency and adherence to chosen patterns and technologies.

**Relationship to Frontend Architecture:**
If the project includes a significant user interface, a separate Frontend Architecture Document will detail the frontend-specific design and MUST be used in conjunction with this document. Core technology stack choices documented herein (see "Tech Stack") are definitive for the entire project, including any frontend components.

## Change Log

| Date | Version | Description | Author |
|------|---------|-------------|--------|
| 2025-12-26 | 0.1 | Initial architecture creation | Winston (Architect) |

## Starter Template or Existing Project

**Decision: Greenfield Project - No Starter Template**

Based on PRD review, this is a greenfield project with no existing codebase. Given the unique architectural requirements (ILP connector + BTP + visualization), manual setup is recommended.

**Rationale:**
- Unique requirements don't align with standard starters (Create React App, NestJS, etc.)
- Monorepo structure (`packages/connector`, `packages/dashboard`, `packages/shared`) needs custom configuration
- Educational value enhanced by building from first principles per PRD goals
- PRD explicitly mentions building custom ILP packet implementation for RFC understanding

**Alternatives Considered:**
- Turborepo/Nx monorepo starters - Rejected (unnecessary complexity for 3-package monorepo)
- Vite React starter - Will use for dashboard package only
- NestJS - Overkill for lightweight connector

**Implementation:** Manual initialization with npm workspaces, TypeScript strict mode, and custom project structure.

# Contributing to Tesbo

Thanks for helping improve Tesbo.

Tesbo is exclusively developed and maintained by QAble Testlab.

## Development

Tesbo is a monorepo with three main services:

- `Tesbo-Frontend/` - Next.js frontend
- `Tesbo-Backend/` - Java 17 backend

Before opening a pull request, please run the relevant checks for the area you changed:

```bash
cd Tesbo-Frontend
npm install
npm run lint
npm run build
```

```bash
cd Tesbo-Backend
mvn test
```

## Pull Requests

- Keep changes focused and explain the user-visible behavior.
- Include tests or validation notes for behavior changes.
- Do not commit secrets, local `.env` files, logs, uploads, screenshots, database dumps, or build output.
- By submitting a contribution, you agree that it is licensed under the Apache License 2.0.

## License

Tesbo is licensed under the Apache License 2.0. See `LICENSE`.

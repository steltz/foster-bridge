// Runs (via jest setupFiles) before any test module loads, in every worker.
// Pins the LLM seam so tests always exercise the Moonshot provider path and
// a developer's real backend/.env can neither flip the provider nor leak a
// real API key into a test process: Nest's ConfigModule/dotenv never
// overrides variables that are already set on process.env.
process.env.LLM_PROVIDER = 'moonshot';
process.env.MOONSHOT_API_KEY = 'test-key';

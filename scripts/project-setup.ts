import { installProject, projectInstallSummary } from '../src/project-setup.ts';
import { errorText } from '../src/process.ts';

try {
  const project = process.argv[2];
  if (!project || process.argv.length > 3) throw new Error('Использование: npm run project:add -- /абсолютный/путь/проекта');
  console.log(projectInstallSummary(installProject(project)));
} catch (error) { console.error(errorText(error)); process.exitCode = 1; }

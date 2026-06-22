import { defaultDatabasePath, getState, openDatabase } from "../server/database.mjs";

const db = openDatabase();
const state = getState(db);
console.log(`SQLite database ready at ${defaultDatabasePath}`);
console.log(`Seeded state: ${state.generalTasks.length} general tasks, ${state.dailyTasks.length} daily tasks, ${state.projects.length} projects.`);
db.close();

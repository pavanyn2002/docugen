import cron from 'node-cron';
import schedule from 'node-schedule';

cron.schedule('*/15 * * * *', syncInventory);
schedule.scheduleJob('reconcile', '0 2 * * *', reconcileLedger);
cron.schedule(CONFIG.interval, dynamicTask);

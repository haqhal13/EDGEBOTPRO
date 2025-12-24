import connectDB, { closeDB } from './config/db';
import { ENV } from './config/env';
import createClobClient from './utils/createClobClient';
import tradeExecutor, { stopTradeExecutor } from './services/tradeExecutor';
import tradeMonitor, { stopTradeMonitor } from './services/tradeMonitor';
import marketTracker from './services/marketTracker';
import { closeMarketPositions } from './services/positionCloser';
import Logger from './utils/logger';
import { performHealthCheck, logHealthCheck } from './utils/healthCheck';
import test from './test/test';

const USER_ADDRESSES = ENV.USER_ADDRESSES;
const PROXY_WALLET = ENV.PROXY_WALLET;

// Graceful shutdown handler
let isShuttingDown = false;

const gracefulShutdown = async (signal: string) => {
    if (isShuttingDown) {
        Logger.warning('Shutdown already in progress, forcing exit...');
        process.exit(1);
    }

    isShuttingDown = true;
    Logger.separator();
    Logger.info(`Received ${signal}, initiating graceful shutdown...`);

    try {
        // Stop services
        stopTradeMonitor();
        stopTradeExecutor();

        // Give services time to finish current operations
        Logger.info('Waiting for services to finish current operations...');
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Close database connection
        await closeDB();

        Logger.success('Graceful shutdown completed');
        process.exit(0);
    } catch (error) {
        Logger.error(`Error during shutdown: ${error}`);
        process.exit(1);
    }
};

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
    Logger.error(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
    // Don't exit immediately, let the application try to recover
});

// Handle uncaught exceptions
process.on('uncaughtException', (error: Error) => {
    Logger.error(`Uncaught Exception: ${error.message}`);
    // Exit immediately for uncaught exceptions as the application is in an undefined state
    gracefulShutdown('uncaughtException').catch(() => {
        process.exit(1);
    });
});

// Handle termination signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

export const main = async () => {
    try {
        // Welcome message for first-time users
        const colors = {
            reset: '\x1b[0m',
            yellow: '\x1b[33m',
            cyan: '\x1b[36m',
        };
        
        console.log(`\n${colors.yellow}💡 First time running the bot?${colors.reset}`);
        console.log(`   Read the guide: ${colors.cyan}GETTING_STARTED.md${colors.reset}`);
        console.log(`   Run health check: ${colors.cyan}npm run health-check${colors.reset}\n`);
        
        await connectDB();
        Logger.startup(USER_ADDRESSES, ENV.TRACK_ONLY_MODE ? '' : PROXY_WALLET);

        // Perform initial health check
        Logger.info('Performing initial health check...');
        const healthResult = await performHealthCheck();
        logHealthCheck(healthResult);

        if (!healthResult.healthy) {
            Logger.warning('Health check failed, but continuing startup...');
        }

        Logger.separator();
        
        // Set up market close callback for position closing
        let clobClientForClosing: Awaited<ReturnType<typeof createClobClient>> | null = null;
        
        if (!ENV.TRACK_ONLY_MODE) {
            Logger.info('Initializing CLOB client...');
            clobClientForClosing = await createClobClient();
            Logger.success('CLOB client ready');
        }
        
        // Set up callback for closing positions when markets are switched
        marketTracker.setMarketCloseCallback(async (market) => {
            await closeMarketPositions(clobClientForClosing, market);
        });
        
        // Display CSV file information
        const { getRunId } = await import('./utils/runId');
        const runId = getRunId();
        Logger.separator();
        Logger.info('📁 CSV Files Initialized (Run ID: ' + runId + ')');
        Logger.info('   • watcher_trades_' + runId + '.csv');
        Logger.info('   • watcher_market_pnl_' + runId + '.csv');
        Logger.info('   • btc_15m_prices_' + runId + '.csv');
        Logger.info('   • eth_15m_prices_' + runId + '.csv');
        Logger.info('   • btc_1h_prices_' + runId + '.csv');
        Logger.info('   • eth_1h_prices_' + runId + '.csv');
        if (!ENV.TRACK_ONLY_MODE) {
            Logger.info('   • paper_trades_' + runId + '.csv');
            Logger.info('   • paper_trading_pnl_' + runId + '.csv');
        }
        Logger.separator();
        
        Logger.info('Starting trade monitor...');
        tradeMonitor();

        // Only start trade executor if not in track-only mode
        if (ENV.TRACK_ONLY_MODE) {
            Logger.separator();
            Logger.info('👀 WATCH MODE ACTIVATED');
            Logger.info('📊 Dashboard will display trader activity on up to 4 markets');
            Logger.info('📈 Shows real-time PnL, positions, and market statistics');
            Logger.info('💾 All trades logged to logs/trades_log.csv');
            Logger.info('💾 Market PnL logged to logs/market_pnl.csv');
            Logger.info('');
            Logger.info('Trade executor disabled - monitoring only, no execution');
            Logger.separator();
        } else {
            Logger.info('Starting trade executor...');
            tradeExecutor(clobClientForClosing!);
        }

        // test(clobClient);
    } catch (error) {
        Logger.error(`Fatal error during startup: ${error}`);
        await gracefulShutdown('startup-error');
    }
};

main();

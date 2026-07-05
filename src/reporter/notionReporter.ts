import { Client } from '@notionhq/client';
import { AppConfig } from '../config';
import { DailyReport } from '../arb/types';
import { CrossTradeRecord } from '../cross-arb/types';

export class NotionReporter {
  private notion: Client;
  private databaseId: string;

  constructor() {
    this.notion = new Client({ auth: AppConfig.notionToken });
    this.databaseId = AppConfig.notionDatabaseId;
  }

  async sendDailyReport(
    internalReport: DailyReport,
    crossTrades: CrossTradeRecord[],
    crossScanCount: number,
    crossMatchCount: number
  ): Promise<void> {
    const contentLines: string[] = [];

    contentLines.push(`报告日期: ${internalReport.date}`);
    contentLines.push('');

    const combinedSuccessful = internalReport.successfulTrades + crossTrades.filter(t => t.success).length;
    const combinedFailed = internalReport.failedTrades + crossTrades.filter(t => !t.success).length;
    const combinedTotal = internalReport.totalTrades + crossTrades.length;
    const combinedProfit = internalReport.totalNetProfit + crossTrades.filter(t => t.success).reduce((s, t) => s + t.netProfit, 0);

    contentLines.push('━━━━━ 总览 ━━━━━');
    contentLines.push(`总交易次数: ${combinedTotal}`);
    contentLines.push(`成功交易: ${combinedSuccessful}`);
    contentLines.push(`失败交易: ${combinedFailed}`);
    contentLines.push(`总净利润: $${combinedProfit.toFixed(4)}`);
    contentLines.push('');

    contentLines.push('━━━━━ 一、内部套利（Predict.fun 平台内） ━━━━━');
    contentLines.push(`扫描轮次: ${internalReport.summary || 'N/A'}`);
    contentLines.push(`交易次数: ${internalReport.totalTrades}`);
    contentLines.push(`成功: ${internalReport.successfulTrades}`);
    contentLines.push(`失败: ${internalReport.failedTrades}`);
    contentLines.push(`预估利润: $${internalReport.totalEstimatedProfit.toFixed(4)}`);
    contentLines.push(`净利润: $${internalReport.totalNetProfit.toFixed(4)}`);
    contentLines.push('');

    if (internalReport.trades.length > 0) {
      contentLines.push('【内部套利明细】');
      for (const trade of internalReport.trades) {
        contentLines.push('');
        contentLines.push(`  市场: ${trade.marketTitle} (ID: ${trade.marketId})`);
        contentLines.push(`  类型: ${trade.type === 'SELL_BOTH' ? '卖出双向' : '买入双向'}`);
        contentLines.push(`  Yes价格: ${trade.yesPrice}, No价格: ${trade.noPrice}`);
        contentLines.push(`  数量: ${trade.quantity}`);
        contentLines.push(`  预估利润: $${trade.estimatedProfit.toFixed(4)}`);
        contentLines.push(`  净利润: $${trade.netProfit.toFixed(4)}`);
        contentLines.push(`  状态: ${trade.success ? '✅ 成功' : '❌ 失败'}`);
        if (trade.error) contentLines.push(`  错误: ${trade.error}`);
      }
    } else {
      contentLines.push('  今日无内部套利交易。');
    }
    contentLines.push('');

    contentLines.push('━━━━━ 二、跨市场套利（Predict.fun ↔ Polymarket） ━━━━━');
    contentLines.push(`事件匹配数: ${crossMatchCount}`);
    contentLines.push(`扫描轮次: ${crossScanCount}`);
    contentLines.push(`交易次数: ${crossTrades.length}`);
    const crossSuccess = crossTrades.filter(t => t.success).length;
    const crossFailed = crossTrades.filter(t => !t.success).length;
    contentLines.push(`成功: ${crossSuccess}`);
    contentLines.push(`失败: ${crossFailed}`);
    const crossProfit = crossTrades.filter(t => t.success).reduce((s, t) => s + t.netProfit, 0);
    const crossEstimated = crossTrades.reduce((s, t) => s + t.estimatedProfit, 0);
    contentLines.push(`预估利润: $${crossEstimated.toFixed(4)}`);
    contentLines.push(`净利润: $${crossProfit.toFixed(4)}`);
    contentLines.push('');

    if (crossTrades.length > 0) {
      contentLines.push('【跨市场套利明细】');
      for (const trade of crossTrades) {
        const dirText = trade.direction === 'PM_YES_PF_NO'
          ? '买Polymarket YES + 买Predict.fun NO'
          : '买Polymarket NO + 买Predict.fun YES';
        contentLines.push('');
        contentLines.push(`  事件: ${trade.eventTitle}`);
        contentLines.push(`  方向: ${dirText}`);
        contentLines.push(`  数量: ${trade.quantity}`);
        contentLines.push(`  PM价格: ${trade.pmPrice}, PF价格: ${trade.pfPrice}`);
        contentLines.push(`  预估利润: $${trade.estimatedProfit.toFixed(4)}`);
        contentLines.push(`  净利润: $${trade.netProfit.toFixed(4)}`);
        contentLines.push(`  状态: ${trade.success ? '✅ 成功' : '❌ 失败'}${trade.hedged ? ' (已对冲)' : ''}`);
        if (trade.error) contentLines.push(`  错误: ${trade.error}`);
      }
    } else {
      contentLines.push('  今日无跨市场套利交易。');
    }
    contentLines.push('');

    if (internalReport.summary) {
      contentLines.push('━━━━━ 总结 ━━━━━');
      contentLines.push(`内部套利: ${internalReport.scanInfo || internalReport.summary}`);
      const crossScanStr = `跨市场套利: 共扫描 ${crossScanCount} 轮，匹配 ${crossMatchCount} 个事件`;
      contentLines.push(crossScanStr);
      contentLines.push(`合计净利润: $${combinedProfit.toFixed(4)}`);
    }

    const content = contentLines.join('\n');

    const MAX_CHUNK = 1800;
    const chunks: string[] = [];
    let remaining = content;
    while (remaining.length > 0) {
      if (remaining.length <= MAX_CHUNK) {
        chunks.push(remaining);
        break;
      }
      let splitIdx = remaining.lastIndexOf('\n', MAX_CHUNK);
      if (splitIdx === -1 || splitIdx < MAX_CHUNK / 2) {
        splitIdx = MAX_CHUNK;
      }
      chunks.push(remaining.slice(0, splitIdx));
      remaining = remaining.slice(splitIdx).trimStart();
    }

    try {
      const richTexts = chunks.map(chunk => ({
        text: { content: chunk },
      }));

      await this.notion.pages.create({
        parent: { database_id: this.databaseId },
        properties: {
          Title: {
            title: [
              {
                text: {
                  content: `套利日报 ${internalReport.date}`,
                },
              },
            ],
          },
          Date: {
            date: {
              start: internalReport.date,
            },
          },
          Content: {
            rich_text: richTexts,
          },
        },
      });
    } catch (error) {
      console.error('Failed to send Notion report:', error);
      throw error;
    }
  }
}

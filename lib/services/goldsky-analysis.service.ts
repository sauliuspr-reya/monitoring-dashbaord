import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

export interface GoldskyPipeline {
  name: string;
  status: 'active' | 'paused';
  tables: string[];
  primaryKeys: Map<string, string[]>;
}

export class GoldskyAnalysisService {
  private pipelinesPath: string;

  constructor(pipelinesPath?: string) {
    if (pipelinesPath) {
      this.pipelinesPath = pipelinesPath;
    } else {
      // Default to ops/goldsky-configs relative to project root
      // process.cwd() in Next.js is the project root (ops/migration-dashboard)
      // So we go up one level to ops/, then into goldsky-configs
      this.pipelinesPath = path.join(process.cwd(),  'goldsky-configs');
    }
  }

  /**
   * Parse all Goldsky pipeline configs and extract table mappings
   */
  async parsePipelines(): Promise<GoldskyPipeline[]> {
    const pipelines: GoldskyPipeline[] = [];
    const configPath = this.pipelinesPath;

    try {
      const files = fs.readdirSync(configPath);
      const yamlFiles = files.filter((f) => f.endsWith('.yaml') && f.includes('pipeline'));

      for (const file of yamlFiles) {
        try {
          const filePath = path.join(configPath, file);
          const content = fs.readFileSync(filePath, 'utf8');
          const config = yaml.load(content) as any;

          if (config && config.sinks) {
            const pipeline: GoldskyPipeline = {
              name: config.name || file.replace('.yaml', ''),
              status: this.determineStatus(config.name),
              tables: [],
              primaryKeys: new Map(),
            };

            // Extract tables from sinks
            for (const sink of Object.values(config.sinks) as any[]) {
              if (sink.type === 'postgres' && sink.table) {
                const tableName = sink.table;
                pipeline.tables.push(tableName);

                // Extract primary key from transform if available
                if (config.transforms) {
                  for (const transform of Object.values(config.transforms) as any[]) {
                    if (transform.primary_key) {
                      const pk = Array.isArray(transform.primary_key)
                        ? transform.primary_key
                        : [transform.primary_key];
                      pipeline.primaryKeys.set(tableName, pk);
                    }
                  }
                }
              }
            }

            if (pipeline.tables.length > 0) {
              pipelines.push(pipeline);
            }
          }
        } catch (error) {
          console.error(`Error parsing ${file}:`, error);
        }
      }
    } catch (error) {
      console.error('Error reading Goldsky configs:', error);
    }

    return pipelines;
  }

  /**
   * Get all tables written by Goldsky pipelines
   */
  async getGoldskyTables(): Promise<Set<string>> {
    const pipelines = await this.parsePipelines();
    const tables = new Set<string>();

    for (const pipeline of pipelines) {
      for (const table of pipeline.tables) {
        tables.add(table);
      }
    }

    return tables;
  }

  /**
   * Get tables written by a specific pipeline
   */
  async getTablesByPipeline(pipelineName: string): Promise<string[]> {
    const pipelines = await this.parsePipelines();
    const pipeline = pipelines.find((p) => p.name === pipelineName);
    return pipeline ? pipeline.tables : [];
  }

  /**
   * Determine pipeline status from name or config
   */
  private determineStatus(pipelineName: string): 'active' | 'paused' {
    // Based on GOLDSKY-TABLES-SUMMARY.md
    const pausedPipelines = [
      'reya-gcp-mainnet-rebalance-pipeline',
      'reya-gcp-mainnet-fee-tiers-pipeline',
      'reya-gcp-mainnet-periphery-pipeline',
    ];

    return pausedPipelines.includes(pipelineName) ? 'paused' : 'active';
  }

  /**
   * Check if a table is written by Goldsky
   */
  async isGoldskyTable(tableName: string): Promise<boolean> {
    const tables = await this.getGoldskyTables();
    return tables.has(tableName);
  }

  /**
   * Get which pipeline writes to a specific table
   */
  async getPipelineForTable(tableName: string): Promise<string | null> {
    const pipelines = await this.parsePipelines();
    for (const pipeline of pipelines) {
      if (pipeline.tables.includes(tableName)) {
        return pipeline.name;
      }
    }
    return null;
  }
}


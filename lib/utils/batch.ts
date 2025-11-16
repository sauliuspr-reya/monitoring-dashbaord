/**
 * Utility functions for batching operations to avoid overwhelming databases
 */

/**
 * Process an array in batches to avoid overwhelming the system
 * @param items Array of items to process
 * @param batchSize Number of items to process in parallel per batch
 * @param processor Function to process each item
 * @returns Array of results in the same order as input
 */
export async function processInBatches<T, R>(
  items: T[],
  batchSize: number,
  processor: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(item => processor(item))
    );
    results.push(...batchResults);
  }
  
  return results;
}

/**
 * Process an array in batches with error handling
 * Continues processing even if some items fail
 * @param items Array of items to process
 * @param batchSize Number of items to process in parallel per batch
 * @param processor Function to process each item
 * @returns Array of results (may include errors)
 */
export async function processInBatchesWithErrors<T, R>(
  items: T[],
  batchSize: number,
  processor: (item: T) => Promise<R>
): Promise<Array<R | Error>> {
  const results: Array<R | Error> = [];
  
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(
      batch.map(item => processor(item))
    );
    
    results.push(...batchResults.map(result => 
      result.status === 'fulfilled' ? result.value : new Error(result.reason?.message || 'Unknown error')
    ));
  }
  
  return results;
}


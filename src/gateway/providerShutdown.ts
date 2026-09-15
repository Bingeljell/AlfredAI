interface ClosableProviderResource {
  close(): Promise<void>;
}

async function closeQuietly(resource: ClosableProviderResource | undefined): Promise<void> {
  if (!resource) return;
  try {
    await resource.close();
  } catch {
    // Shutdown must continue without logging provider errors, which may carry
    // account-specific details.
  }
}

export async function closeCodexProviderResources(resources: {
  subscriptionService?: ClosableProviderResource;
  accountService?: ClosableProviderResource;
}): Promise<void> {
  await closeQuietly(resources.subscriptionService);
  await closeQuietly(resources.accountService);
}

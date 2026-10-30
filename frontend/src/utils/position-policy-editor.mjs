const CHANNELS = ['web', 'mini'];
const IDENTITY = 'store-manager.identity';

export function policyChannels(permissions) {
  return CHANNELS.filter(channel => permissions[channel]?.length > 0);
}

export function permissionTree(groups, disabled = false) {
  return groups.map(group => ({
    id: 'g/' + group.key,
    label: group.label,
    disabled,
    children: group.modules.map(module => {
      const leaves = module.items.map(item => ({
        id: 'p/' + item.key, label: item.label, disabled,
      }));
      if (leaves.length === 1 && leaves[0].label === module.label) {
        return { ...leaves[0], description: module.description };
      }
      return {
        id: 'm/' + module.key, label: module.label,
        description: module.description, disabled, children: leaves,
      };
    }),
  }));
}

export function selectedPermissions(channel, selected, previous = []) {
  const permissions = new Set(selected);
  for (const code of selected) {
    if (!code.startsWith('staff.field.')) continue;
    if (channel === 'web') permissions.add('staff.view');
    if (code.endsWith('.edit')) {
      permissions.add(code.replace(/\.edit$/, '.view'));
      if (channel === 'web') permissions.add('staff.edit');
    }
    if (code.startsWith('staff.field.') && /\.(download|export)$/.test(code)) permissions.add(code.replace(/\.(download|export)$/, '.view'));
    if (channel === 'web' && code.startsWith('staff.field.') && code.endsWith('.export')) permissions.add('staff.export');
  }
  // Keep the existing internal identity during edits, but revoke it when all
  // visible permissions are explicitly cleared, as with clearing a platform.
  if (permissions.size && previous.includes(IDENTITY)) permissions.add(IDENTITY);
  return [...permissions];
}

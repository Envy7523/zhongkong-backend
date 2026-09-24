function ageFromIdCard(value, today = new Date()) {
  const idCard = String(value || '').trim().toUpperCase();
  const match = idCard.match(/^\d{6}(\d{4})(\d{2})(\d{2})\d{3}[0-9X]$/);
  if (!match) return null;
  const birth = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (birth.getFullYear() !== Number(match[1]) || birth.getMonth() !== Number(match[2]) - 1 || birth.getDate() !== Number(match[3])) return null;
  let age = today.getFullYear() - birth.getFullYear();
  if (today.getMonth() < birth.getMonth() || (today.getMonth() === birth.getMonth() && today.getDate() < birth.getDate())) age -= 1;
  return age >= 0 && age <= 130 ? age : null;
}

function refreshStaffAges(db) {
  let updated = 0;
  for (const employee of db.queryAll('SELECT id,id_card_number,age FROM employees')) {
    const age = ageFromIdCard(employee.id_card_number);
    if (age !== null && age !== employee.age) {
      db.run('UPDATE employees SET age=? WHERE id=?', [age, employee.id]);
      updated++;
    }
  }
  return updated;
}
module.exports = { ageFromIdCard, refreshStaffAges };

const { Sequelize, DataTypes } = require('sequelize');
const sequelize = new Sequelize('sqlite::memory:');

const Ticket = sequelize.define('Ticket', {
  reference: { type: DataTypes.STRING, allowNull: false, unique: true },
  seatCount: { type: DataTypes.INTEGER, allowNull: false },
  notes: DataTypes.TEXT,
  eventId: { type: DataTypes.INTEGER, references: { model: 'Events', key: 'id' } },
}, { tableName: 'tickets' });

module.exports = { Ticket };

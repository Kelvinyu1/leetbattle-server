// A MongoDB interface, contains validation logic about the columns
const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true,
    minlength: 1,
    maxlength: 20,
    trim: true
  },
  password: {
    type: String,
    required: true,
    minlength: 1
  },
  wins: {
    type: Number,
    default: 0
  },
  losses: {
    type: Number,
    default: 0
  }
});

// Method to compare passwords during login (simple string comparison)
userSchema.methods.comparePassword = function(candidatePassword) {
  return this.password === candidatePassword;
};

// Method return user data without password
userSchema.methods.toJSON = function() {
  const user = this.toObject();
  delete user.password; // Don't send password to frontend
  return user;
};

module.exports = mongoose.model('User', userSchema);

import mongoose, { Schema } from 'mongoose';
const EnquirySchema = new Schema({ topic: String });
mongoose.model('Enquiry', EnquirySchema);
